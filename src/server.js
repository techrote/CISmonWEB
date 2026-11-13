import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config-store.js";
import { FileHistoryStore } from "./history-store.js";
import { Monitor } from "./monitor.js";
import { InteractionError, InteractionStore } from "./interaction-store.js";
import { prAssociation, validPinScope, validRepository, validRun } from "../shared/interactions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const sharedDir = path.resolve(__dirname, "../shared");
const artDir = path.join(publicDir, "art");
const configStore = new ConfigStore();
const history = new FileHistoryStore(configStore.dataDir);
const interactions = new InteractionStore(configStore.dataDir);
const monitor = new Monitor(configStore, history, interactions);

const HOST = process.env.CISMON_HOST || "127.0.0.1";
const PORT = Number(process.env.CISMON_PORT || 8787);
const MAX_JSON_BYTES = 262144;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hostname(value) {
  const literal = value.includes(":") && !value.startsWith("[") ? "[" + value + "]" : value;
  return new URL("http://" + literal).hostname.toLowerCase().replace(/\.$/, "");
}

function requestUrl(req) {
  const authority = req.headers.host;
  let base;
  try {
    if (!authority || /[\s/@\\?#]/.test(authority)) throw new Error("invalid Host");
    base = new URL("http://" + authority);
  } catch {
    throw new HttpError(400, "invalid Host header");
  }
  // Loopback binding alone does not stop DNS rebinding: an untrusted web
  // origin can resolve to the local listener while retaining its own Host.
  // Explicit bind names and the socket's local address support deliberate
  // LAN/proxy setups, without trusting arbitrary forwarded headers.
  const trusted = new Set(["localhost", "127.0.0.1", "[::1]", hostname(HOST)]);
  if (req.socket.localAddress) trusted.add(hostname(req.socket.localAddress));
  if (!trusted.has(base.hostname.toLowerCase().replace(/\.$/, ""))) {
    throw new HttpError(403, "untrusted Host header");
  }
  let url;
  try { url = new URL(req.url, base); }
  catch { throw new HttpError(400, "invalid request URL"); }
  if (url.origin !== base.origin) throw new HttpError(400, "request URL must match Host");
  if (url.pathname.startsWith("/api/")) {
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") {
      throw new HttpError(403, "cross-origin API requests are not allowed");
    }
    if (req.headers.origin !== undefined && req.headers.origin !== base.origin) {
      throw new HttpError(403, "cross-origin API requests are not allowed");
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const contentType = (req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") throw new HttpError(415, "API writes require application/json");
    }
  }
  return url;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...(status === 413 ? { Connection: "close" } : {})
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  if (Number(req.headers["content-length"]) > MAX_JSON_BYTES) {
    req.resume();
    throw new HttpError(413, "request body too large");
  }
  // Decode once, after collecting bounded bytes: Buffer-to-string conversion
  // per TCP chunk corrupts a Unicode character split across two chunks.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) {
      req.resume();
      throw new HttpError(413, "request body too large");
    }
    chunks.push(chunk);
  }
  let value;
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    value = body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, "request body must contain valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value;
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

async function serveFile(filePath, contentType, res) {
  const data = await readFile(filePath);
  res.writeHead(200, { ...securityHeaders(), "Content-Type": contentType, "Cache-Control": "no-cache" });
  res.end(data);
}

async function serveStatic(urlPath, res) {
  const routes = {
    "/": [path.join(publicDir, "index.html"), "text/html; charset=utf-8"],
    "/app.js": [path.join(publicDir, "app.js"), "text/javascript; charset=utf-8"],
    "/context-menu.js": [path.join(publicDir, "context-menu.js"), "text/javascript; charset=utf-8"],
    "/notifications.js": [path.join(publicDir, "notifications.js"), "text/javascript; charset=utf-8"],
    "/interactions.js": [path.join(sharedDir, "interactions.js"), "text/javascript; charset=utf-8"],
    "/styles.css": [path.join(publicDir, "styles.css"), "text/css; charset=utf-8"],
    "/surfaces.js": [path.join(sharedDir, "surfaces.js"), "text/javascript; charset=utf-8"],
    "/focus-grid.js": [path.join(sharedDir, "focus-grid.js"), "text/javascript; charset=utf-8"],
    "/workflow-view.js": [path.join(sharedDir, "workflow-view.js"), "text/javascript; charset=utf-8"],
    "/focus-grid-view.js": [path.join(publicDir, "focus-grid.js"), "text/javascript; charset=utf-8"],
    "/fun-core.js": [path.join(sharedDir, "fun-core.js"), "text/javascript; charset=utf-8"],
    "/hungry-ci.js": [path.join(sharedDir, "hungry-ci.js"), "text/javascript; charset=utf-8"],
    "/hungry-frame-engine.js": [path.join(publicDir, "hungry-frame-engine.js"), "text/javascript; charset=utf-8"],
    "/fun-engine.js": [path.join(publicDir, "fun-engine.js"), "text/javascript; charset=utf-8"],
    "/fun-surfaces.js": [path.join(publicDir, "fun-surfaces.js"), "text/javascript; charset=utf-8"]
  };
  const route = routes[urlPath];
  if (!route) return false;
  await serveFile(route[0], route[1], res);
  return true;
}

// Original artwork is kept independently, with no API access. Only this
// sandboxed frame receives the bridge. Never relax the parent page CSP.
export async function serveHungryFrame(res) {
  const [original, bridge] = await Promise.all([
    readFile(path.join(artDir, "037-hungry-margins3.html"), "utf8"),
    readFile(path.join(artDir, "hungry-bridge.js"), "utf8")
  ]);
  const hiddenChrome = "<style id=\"cismon-frame-only\">body>header,body>footer{display:none!important}</style>";
  const injection = hiddenChrome + "<script>\n" + bridge + "\n</script>";
  if (!original.includes("</body>")) throw new Error("original Hungry Margins artwork is incomplete");
  // Some iframe engines report a 0×0 viewport while its first synchronous
  // script executes. Preserve every original visual hook, but guard the
  // original bootstrap resize against a zero-sized backing canvas.
  const originalResize = "function resize(){E.w=innerWidth;E.h=innerHeight;";
  if (!original.includes(originalResize)) throw new Error("037 viewport bootstrap signature changed");
  const compatible = original.replace(
    originalResize,
    "function resize(){E.w=Math.max(1,innerWidth||canvas.clientWidth||960);" +
    "E.h=Math.max(1,innerHeight||canvas.clientHeight||600);"
  );
  const html = compatible.replace("</body>", injection + "</body>");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // The frame is both CSP-restricted and iframe-sandboxed (opaque origin).
    // Original user-supplied source uses many inline scripts and styles.
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "img-src data: blob:; connect-src 'none'; font-src 'none'; object-src 'none'; " +
      "form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = requestUrl(req);

    if (req.method === "GET" && url.pathname === "/art/hungry-frame") return await serveHungryFrame(res);
    if (req.method === "GET" && url.pathname === "/art/037-hungry-margins3.html") {
      return await serveFile(path.join(artDir, "037-hungry-margins3.html"), "text/plain; charset=utf-8", res);
    }

    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, monitor.state());
    if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, configStore.publicConfig());
    if (req.method === "GET" && url.pathname === "/api/interactions") return json(res, 200, interactions.publicState());

    if (req.method === "POST" && url.pathname === "/api/interactions") {
      const body = await readJson(req);
      const { action, repository, runId, runAttempt, scope, generation } = body;
      if (!["pin", "unpin", "arm-run", "cancel-run", "arm-pr", "cancel-pr", "resolve-pr"].includes(action)) {
        throw new HttpError(400, "unknown run action");
      }
      if (generation !== undefined && (typeof generation !== "string" || generation.length > 100)) {
        throw new HttpError(400, "invalid subscription generation");
      }
      if (action === "cancel-pr") {
        if (!validRepository(repository) || !Number.isSafeInteger(body.prNumber) || body.prNumber < 1) {
          throw new HttpError(400, "a valid repository and PR number are required");
        }
        return json(res, 200, await interactions.cancel("pr", { repository, prNumber: body.prNumber }, generation));
      }
      const identity = { repository, runId, runAttempt };
      if (!validRun(identity)) throw new HttpError(400, "a repository, positive run ID and exact run attempt are required");
      if (action === "cancel-run") return json(res, 200, await interactions.cancel("run", identity, generation));
      if (action === "pin" || action === "unpin") {
        if (!validPinScope(scope)) throw new HttpError(400, "a valid surface and pane scope are required");
        // Deleted surfaces and temporarily hidden panes can always be
        // unpinned from management without recreating their configuration.
        if (action === "unpin") return json(res, 200, await interactions.setPin(identity, scope, false));
        if (!configStore.current.surfaces.some(surface => surface.id === scope.surfaceId)) {
          throw new HttpError(409, "surface no longer exists; reopen the context menu");
        }
      }
      const run = monitor.interactionRun(repository, runId, runAttempt);
      if (!run) throw new HttpError(409, "run attempt is no longer available; refresh and reopen the menu");
      if (action === "resolve-pr") {
        monitor.requestPrAssociation(identity);
        return json(res, 200, interactions.publicState());
      }
      if (action === "pin") return json(res, 200, await interactions.setPin(run, scope));
      if (action === "arm-run") return json(res, 200, await interactions.armRun(run));
      const association = prAssociation(run);
      if (association.status !== "resolved") {
        monitor.requestPrAssociation(identity);
        throw new HttpError(409, association.reason);
      }
      if (body.prNumber !== undefined && body.prNumber !== association.number) {
        throw new HttpError(409, "PR association changed; reopen the context menu");
      }
      return json(res, 200, await interactions.armPr(repository, association.number));
    }

    if (req.method === "POST" && url.pathname === "/api/notifications/settings") {
      return json(res, 200, await interactions.setSettings(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/claim") {
      return json(res, 200, await interactions.claim(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/begin") {
      return json(res, 200, await interactions.begin(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/notifications/ack") {
      return json(res, 200, await interactions.acknowledge(await readJson(req)));
    }

    if (req.method === "PUT" && url.pathname === "/api/config") {
      const value = await monitor.applyConfig(await readJson(req));
      return json(res, 200, value);
    }

    if (req.method === "PUT" && url.pathname === "/api/display") {
      const value = await monitor.applyDisplayConfig(await readJson(req));
      return json(res, 200, value);
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      await readJson(req);
      await monitor.refresh();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/acknowledge") {
      const body = await readJson(req);
      const runAttempt = body.runAttempt === undefined ? 1 : body.runAttempt;
      if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
        throw new HttpError(400, "runAttempt must be a positive integer");
      }
      const runId = Number(body.runId);
      if (!monitor.tracker.find(body.repository, runId)) {
        throw new HttpError(404, "run not found");
      }
      if (!monitor.tracker.acknowledge(body.repository, runId, runAttempt)) {
        throw new HttpError(409, "run attempt changed; reopen run details");
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/watch") {
      const body = await readJson(req);
      if (body.runAttempt !== undefined) {
        if (!validRun(body)) throw new HttpError(400, "a valid exact run attempt is required");
        const current = monitor.tracker.find(body.repository, body.runId);
        if (!current || (current.snapshot.runAttempt || 1) !== body.runAttempt) {
          throw new HttpError(409, "only the current tracked attempt can change manual watch state");
        }
      }
      return json(res, monitor.tracker.setManualWatch(body.repository, Number(body.runId), body.watched) ? 200 : 404, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/run") {
      const runAttempt = url.searchParams.has("runAttempt") ? Number(url.searchParams.get("runAttempt")) : undefined;
      if (runAttempt !== undefined && (!Number.isSafeInteger(runAttempt) || runAttempt < 1)) {
        throw new HttpError(400, "runAttempt must be a positive integer");
      }
      const detail = monitor.detail(url.searchParams.get("repository") || "", Number(url.searchParams.get("runId")), runAttempt);
      return detail ? json(res, 200, detail) : json(res, 404, { error: "run not found" });
    }

    if (req.method === "GET" && await serveStatic(url.pathname, res)) return;
    json(res, 404, { error: "not found" });
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.destroy();
    json(res, error instanceof HttpError || error instanceof InteractionError ? error.status : 500, { error: error.message });
  }
});

await interactions.load();
await monitor.init();

server.listen(PORT, HOST, () => {
  console.log("CISmonWEB listening on http://" + HOST + ":" + PORT);
  if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
    console.warn("CISmonWEB is listening beyond loopback; protect the local configuration endpoint.");
  }
});

function shutdown() {
  monitor.stop();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
