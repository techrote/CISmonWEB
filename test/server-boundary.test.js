import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { InteractionStore } from "../src/interaction-store.js";

const projectDir = fileURLToPath(new URL("../", import.meta.url));

async function startServer(t, cwd = projectDir, seed = null) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cismon-http-data-"));
  if (seed) await seed(dataDir);
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd,
    env: { ...process.env, GITHUB_TOKEN: "", CISMON_OWNER: "", CISMON_DATA_DIR: dataDir, CISMON_HOST: "127.0.0.1", CISMON_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + port;
  for (let attempt = 0; attempt < 70; attempt++) {
    if (child.exitCode !== null) throw new Error("server terminated: " + output);
    try {
      const response = await fetch(base + "/api/state", { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { base, port };
    } catch {}
    await delay(50);
  }
  throw new Error("server failed to start: " + output);
}

function request(base, pathname, { method = "GET", headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers, signal: AbortSignal.timeout(5000) }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    (async () => {
      for (let index = 0; index < chunks.length; index++) {
        req.write(chunks[index]);
        // Force the split-codepoint regression to cross received chunks.
        if (index + 1 < chunks.length) await delay(25);
      }
      req.end();
    })().catch(reject);
  });
}

test("local API rejects foreign browser origins and untrusted Host names", async (t) => {
  const { base, port } = await startServer(t);
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    const response = await request(base, "/api/config", { headers: { Host: hostname + ":" + port } });
    assert.equal(response.status, 200, hostname);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  assert.equal((await request(base, "/api/config", { headers: { Host: "untrusted.example:" + port } })).status, 403);
  assert.equal((await request(base, "/", { headers: { Host: "untrusted.example:" + port } })).status, 403);
  for (const headers of [
    { Origin: "https://untrusted.example", "Content-Type": "text/plain" },
    { Origin: "http://127.0.0.1:" + (port + 1), "Content-Type": "application/json" },
    { Origin: "null", "Content-Type": "application/json" },
    { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
    { "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" }
  ]) {
    assert.equal((await request(base, "/api/refresh", { method: "POST", headers })).status, 403, JSON.stringify(headers));
  }
  const local = await request(base, "/api/refresh", {
    method: "POST", headers: { Origin: base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }
  });
  assert.equal(local.status, 200);
});

test("local API reports invalid JSON and media types as client errors without changing saved settings", async (t) => {
  const { base } = await startServer(t);
  const before = await (await fetch(base + "/api/config")).json();
  for (const body of ["{", "null", "[]", '"text"']) {
    const response = await request(base, "/api/config", {
      method: "PUT", headers: { "Content-Type": "application/json" }, chunks: [body]
    });
    assert.equal(response.status, 400, body);
  }
  const form = await request(base, "/api/display", {
    method: "PUT", headers: { "Content-Type": "text/plain" }, chunks: ['{"activeSurfaceId":"dense"}']
  });
  assert.equal(form.status, 415);
  assert.equal((await request(base, "/api/refresh", { method: "POST" })).status, 415);
  assert.deepEqual(await (await fetch(base + "/api/config")).json(), before);
});

test("JSON request limits count UTF-8 bytes and preserve codepoints split across chunks", async (t) => {
  const { base } = await startServer(t);
  const name = "Télémetry 🛰";
  const config = await (await fetch(base + "/api/config")).json();
  const surfaces = config.surfaces.map((surface, index) => index ? surface : { ...surface, name });
  const displayBytes = Buffer.from(JSON.stringify({ surfaces }));
  const displaySplit = displayBytes.indexOf(Buffer.from("é")) + 1;
  const display = await request(base, "/api/display", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    chunks: [displayBytes.subarray(0, displaySplit), displayBytes.subarray(displaySplit)]
  });
  assert.equal(display.status, 200);
  assert.equal(JSON.parse(display.text).surfaces[0].name, name);
  const oversized = Buffer.from(JSON.stringify({ ignored: "é".repeat(140000) }));
  assert.ok(oversized.length > 262144);
  const rejected = await request(base, "/api/display", {
    method: "PUT", headers: { "Content-Type": "application/json" }, chunks: [oversized]
  });
  assert.equal(rejected.status, 413);
  assert.equal((await fetch(base + "/api/state")).status, 200, "the server must survive rejected bodies");
});

test("acknowledgement validates attempt identity at the HTTP boundary", async (t) => {
  const { base } = await startServer(t);
  for (const runAttempt of [null, 0, -1, 1.5, "2"]) {
    const response = await request(base, "/api/acknowledge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      chunks: [JSON.stringify({ repository: "owner/repo", runId: 1, runAttempt })]
    });
    assert.equal(response.status, 400);
    assert.match(JSON.parse(response.text).error, /positive integer/);
  }
  const missing = await request(base, "/api/acknowledge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    chunks: [JSON.stringify({ repository: "owner/repo", runId: 1, runAttempt: 2 })]
  });
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.text).ok, undefined);
});

test("an unavailable artwork asset returns an HTTP failure without terminating the monitor", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cismon-http-package-"));
  await cp(path.join(projectDir, "src"), path.join(cwd, "src"), { recursive: true });
  await cp(path.join(projectDir, "shared"), path.join(cwd, "shared"), { recursive: true });
  await cp(path.join(projectDir, "package.json"), path.join(cwd, "package.json"));
  const { base } = await startServer(t, cwd);
  // After hooks run in registration order. Stop the child before removing its
  // working directory, which Windows keeps locked while the process is alive.
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const resource of ["/art/hungry-frame", "/art/037-hungry-margins3.html"]) {
    assert.equal((await fetch(base + resource, { signal: AbortSignal.timeout(2000) })).status, 500);
    assert.equal((await fetch(base + "/api/state")).status, 200);
  }
});

test("completion API preserves same-origin security and validates exact identities and settings", async t => {
  const { base } = await startServer(t);
  const before = await (await fetch(base + "/api/config")).json();
  for (const pathname of ["/api/interactions", "/api/notifications/settings", "/api/notifications/claim", "/api/notifications/begin", "/api/notifications/ack"]) {
    assert.equal((await request(base, pathname, {
      method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" }, chunks: ["{}"]
    })).status, 403, pathname);
    assert.equal((await request(base, pathname, { method: "POST", headers: { "Content-Type": "text/plain" }, chunks: ["{}"] })).status, 415);
  }
  const post = (pathname, value) => request(base, pathname, {
    method: "POST", headers: { "Content-Type": "application/json" }, chunks: [JSON.stringify(value)]
  });
  for (const value of [
    { action: "arm-run", repository: "owner/repo", runId: 1 },
    { action: "arm-run", repository: "../secrets", runId: 1, runAttempt: 1 },
    { action: "pin", repository: "owner/repo", runId: 1, runAttempt: "1", scope: { surfaceId: "focus", paneId: "main" } },
    { action: "cancel-pr", repository: "owner/repo", prNumber: 0 },
    { action: "execute", repository: "owner/repo", runId: 1, runAttempt: 1 }
  ]) assert.equal((await post("/api/interactions", value)).status, 400);
  assert.equal((await post("/api/interactions", { action: "arm-run", repository: "owner/repo", runId: 1, runAttempt: 1 })).status, 409);
  for (const value of [{ volume: 2 }, { volume: "0.4" }, { muted: "false" }, { soundEnabled: 1 }]) {
    assert.equal((await post("/api/notifications/settings", value)).status, 400);
  }
  assert.equal((await post("/api/notifications/claim", { clientId: "invalid/id", audioReady: true })).status, 400);
  const saved = await post("/api/notifications/settings", { soundEnabled: true, volume: 0.2, githubToken: "must-not-persist" });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.text).settings, { soundEnabled: true, muted: false, volume: 0.2 });
  assert.doesNotMatch(saved.text, /must-not-persist|githubToken/);
  assert.deepEqual(await (await fetch(base + "/api/config")).json(), before, "sound writes cannot alter surface/token configuration");
  assert.equal((await request(base, "/api/run?repository=owner/repo&runId=1&runAttempt=0")).status, 400);
  assert.equal((await post("/api/watch", { repository: "owner/repo", runId: 1, runAttempt: 2, watched: true })).status, 409);
  for (const route of ["/context-menu.js", "/notifications.js", "/interactions.js"]) {
    const response = await request(base, route);
    assert.equal(response.status, 200);
    assert.match(response.headers["content-security-policy"], /script-src 'self'/);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
});

test("production HTTP delivery serializes two clients and persists consumed/acknowledged event status", async t => {
  const { base } = await startServer(t, projectDir, async dataDir => {
    const store = new InteractionStore(dataDir);
    await store.load();
    await store.setSettings({ soundEnabled: true });
    const run = { repository: "owner/repo", runId: 81, runAttempt: 2, workflowName: "CI", state: "in_progress", conclusion: "unknown" };
    await store.armRun(run);
    const now = Date.now();
    await store.observeRun(run, { requestStartedAtMs: now, confirmedAtMs: now });
    await store.observeRun({ ...run, state: "completed", conclusion: "success" }, { requestStartedAtMs: now, confirmedAtMs: now });
    // Advance this fixture's coalescing age without altering production API
    // responses or the claim/consume/ack implementation under test.
    const state = JSON.parse(await (await import("node:fs/promises")).readFile(store.filePath, "utf8"));
    state.events[0].observedAtMs -= 2000;
    await (await import("node:fs/promises")).writeFile(store.filePath, JSON.stringify(state));
  });
  const post = async (pathname, value) => {
    const response = await fetch(base + pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    return { status: response.status, value: await response.json() };
  };
  const claims = await Promise.all(["browser-alpha", "browser-bravo"].map(clientId => post("/api/notifications/claim", { clientId, audioReady: true })));
  assert.ok(claims.every(response => response.status === 200));
  assert.equal(claims.filter(response => response.value.claimId).length, 1);
  const index = claims.findIndex(response => response.value.claimId);
  const identity = { clientId: ["browser-alpha", "browser-bravo"][index], claimId: claims[index].value.claimId };
  const starts = await Promise.all([post("/api/notifications/begin", identity), post("/api/notifications/begin", identity)]);
  assert.deepEqual(starts.map(response => response.status).sort(), [200, 409]);
  const beforeAck = await (await fetch(base + "/api/state")).json();
  assert.equal(beforeAck.interactions.events[0].delivery.status, "attempted");
  assert.equal(beforeAck.interactions.events[0].delivery.claimId, undefined);
  const ack = await post("/api/notifications/ack", { ...identity, status: "played" });
  assert.equal(ack.status, 200);
  assert.equal(ack.value.events[0].delivery.status, "played");
  assert.equal((await post("/api/notifications/claim", { clientId: "browser-charlie", audioReady: true })).value.claimId, null);
});
