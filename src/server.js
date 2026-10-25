import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "./config-store.js";
import { FileHistoryStore } from "./history-store.js";
import { Monitor } from "./monitor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const sharedDir = path.resolve(__dirname, "../shared");
const artDir = path.join(publicDir, "art");
const configStore = new ConfigStore();
const history = new FileHistoryStore(configStore.dataDir);
const monitor = new Monitor(configStore, history);

const HOST = process.env.CISMON_HOST || "127.0.0.1";
const PORT = Number(process.env.CISMON_PORT || 8787);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 262144) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
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
    "/styles.css": [path.join(publicDir, "styles.css"), "text/css; charset=utf-8"],
    "/surfaces.js": [path.join(sharedDir, "surfaces.js"), "text/javascript; charset=utf-8"],
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
  const html = original.replace("</body>", injection + "</body>");
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
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

    if (req.method === "GET" && url.pathname === "/art/hungry-frame") return serveHungryFrame(res);
    if (req.method === "GET" && url.pathname === "/art/037-hungry-margins3.html") {
      return serveFile(path.join(artDir, "037-hungry-margins3.html"), "text/plain; charset=utf-8", res);
    }

    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, monitor.state());
    if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, configStore.publicConfig());

    if (req.method === "PUT" && url.pathname === "/api/config") {
      const value = await monitor.applyConfig(await readJson(req));
      return json(res, 200, value);
    }

    if (req.method === "PUT" && url.pathname === "/api/display") {
      const value = await monitor.applyDisplayConfig(await readJson(req));
      return json(res, 200, value);
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      await monitor.refresh();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/acknowledge") {
      const body = await readJson(req);
      return json(res, monitor.tracker.acknowledge(body.repository, Number(body.runId)) ? 200 : 404, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/watch") {
      const body = await readJson(req);
      return json(res, monitor.tracker.setManualWatch(body.repository, Number(body.runId), body.watched) ? 200 : 404, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/run") {
      const detail = monitor.detail(url.searchParams.get("repository") || "", Number(url.searchParams.get("runId")));
      return detail ? json(res, 200, detail) : json(res, 404, { error: "run not found" });
    }

    if (req.method === "GET" && await serveStatic(url.pathname, res)) return;
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

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
