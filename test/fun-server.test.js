import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(dir, port) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_TOKEN: "",
      CISMON_OWNER: "",
      CISMON_DATA_DIR: dir,
      CISMON_HOST: "127.0.0.1",
      CISMON_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  const base = "http://127.0.0.1:" + port;
  for (let attempt = 0; attempt < 70; attempt++) {
    if (child.exitCode !== null) throw new Error("server terminated: " + output);
    try {
      const response = await fetch(base + "/api/state");
      if (response.ok) return { child, base };
    } catch {}
    await delay(75);
  }
  child.kill();
  throw new Error("server failed to start: " + output);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(1500)
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("local server serves animation assets and migrates legacy profiles without leaking token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismonweb-fun-"));
  let running;
  try {
    await writeFile(path.join(dir, "config.json"), JSON.stringify({
      githubToken: "",
      activeSurfaceId: "focus",
      surfaces: [{ id: "focus", name: "My Custom Focus", layout: "rows", maxItems: 41 }],
      maxRepositories: 20
    }));
    running = await startServer(dir, await freePort());
    const config = await (await fetch(running.base + "/api/config")).json();
    assert.equal(config.githubToken, undefined);
    assert.equal(config.surfaces[0].name, "My Custom Focus");
    assert.equal(config.surfaces[0].maxItems, 41);
    assert.deepEqual(config.surfaces.slice(1).map((s) => s.id), [
      "signal-retention", "afterimage-debt", "repository-lanes-plus", "hungry-margins"
    ]);

    for (const asset of ["/fun-core.js", "/fun-engine.js", "/fun-surfaces.js"]) {
      const response = await fetch(running.base + asset);
      assert.equal(response.status, 200, asset);
      assert.match(response.headers.get("content-type"), /javascript/);
      assert.ok((await response.text()).length > 200);
    }
    const page = await (await fetch(running.base + "/")).text();
    assert.match(page, /hungry_margins/);
    assert.match(page, /surfaceMotion/);

    const selected = await fetch(running.base + "/api/display", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeSurfaceId: "hungry-margins" })
    });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).activeSurfaceId, "hungry-margins");
    const persisted = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
    assert.equal(persisted.surfacePresetVersion, 2);
    assert.equal(persisted.activeSurfaceId, "hungry-margins");
  } finally {
    if (running) await stopServer(running.child);
    await rm(dir, { recursive: true, force: true });
  }
});
