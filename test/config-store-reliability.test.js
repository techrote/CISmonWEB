import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/config-store.js";

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("environment credentials remain runtime-only and continue to override saved settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismon-config-env-"));
  try {
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ githubToken: "stored-token", githubOwner: "stored-owner" }));
    await withEnvironment({ GITHUB_TOKEN: "environment-token", CISMON_OWNER: "environment-owner" }, async () => {
      const store = new ConfigStore(dir);
      await store.load();
      await store.update({ activeSurfaceId: "dense" });
      const saved = JSON.parse(await readFile(store.configPath, "utf8"));
      assert.equal(saved.githubToken, "stored-token", "display saves must not copy environment credentials to disk");
      assert.equal(saved.githubOwner, "stored-owner");
      assert.equal(store.current.githubToken, "environment-token");
      assert.equal(store.current.githubOwner, "environment-owner");
      assert.equal(store.publicConfig().githubToken, undefined);
      assert.equal(store.publicConfig().githubTokenSource, "environment");
      assert.equal(store.publicConfig().hasStoredGithubToken, true);

      await store.update({ githubToken: "replacement-token", githubOwner: "replacement-owner" });
      assert.equal(store.current.githubToken, "environment-token", "saving a token cannot disable the environment override");
      assert.equal(store.current.githubOwner, "environment-owner");
      assert.equal(JSON.parse(await readFile(store.configPath, "utf8")).githubToken, "replacement-token");
      await store.update({ clearGithubToken: true });
      assert.equal(store.current.githubToken, "environment-token");
      assert.equal(store.publicConfig().hasStoredGithubToken, false);
      assert.equal(store.publicConfig().hasGithubToken, true);
      assert.doesNotMatch(await readFile(store.configPath, "utf8"), /environment-token|replacement-token|clearGithubToken|hasGithubToken/);
    });
    await withEnvironment({ GITHUB_TOKEN: undefined, CISMON_OWNER: undefined }, async () => {
      const reloaded = new ConfigStore(dir);
      await reloaded.load();
      assert.equal(reloaded.current.githubToken, "");
      assert.equal(reloaded.current.githubOwner, "replacement-owner");
      assert.equal(reloaded.publicConfig().githubTokenSource, "none");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent saves return their own committed snapshot and preserve all ordered patches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismon-config-queue-"));
  try {
    await withEnvironment({ GITHUB_TOKEN: undefined, CISMON_OWNER: undefined }, async () => {
      const store = new ConfigStore(dir);
      await store.load();
      const [first, second, third] = await Promise.all([
        store.update({ githubOwner: "first-owner", historyDepth: 96 }),
        store.update({ githubOwner: "second-owner", maxRepositories: 42 }),
        store.update({ activeAgeDays: 14 })
      ]);
      assert.equal(first.githubOwner, "first-owner");
      assert.equal(first.maxRepositories, 20);
      assert.equal(second.githubOwner, "second-owner");
      assert.equal(second.historyDepth, 96);
      assert.equal(second.activeAgeDays, 7);
      assert.equal(third.maxRepositories, 42);
      assert.equal(third.activeAgeDays, 14);
      assert.deepEqual(JSON.parse(await readFile(store.configPath, "utf8")), store.current);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed configuration replacement retains the accepted snapshot and does not poison later saves", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismon-config-failure-"));
  try {
    const store = new ConfigStore(dir);
    await store.load();
    await store.update({ activeAgeDays: 11 });
    const before = store.current;
    // A target that cannot be replaced is a deterministic write failure on all
    // test accounts, including root (where chmod-based failures are unreliable).
    await rm(store.configPath);
    await mkdir(store.configPath);
    await assert.rejects(store.update({ activeAgeDays: 19 }));
    assert.equal(store.current, before);
    assert.equal(store.current.activeAgeDays, 11);
    assert.deepEqual(await readdir(dir), ["config.json"], "failed saves must clean up their temporary credential file");
    await rm(store.configPath, { recursive: true });
    await store.update({ maxRepositories: 37 });
    assert.equal(store.current.activeAgeDays, 11);
    assert.equal(JSON.parse(await readFile(store.configPath, "utf8")).maxRepositories, 37);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
