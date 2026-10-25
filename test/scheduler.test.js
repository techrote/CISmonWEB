import assert from "node:assert/strict";
import test from "node:test";
import {
  dueActiveRun,
  dueRepository,
  shouldServiceActive,
  takeSweepBatch
} from "../src/scheduler.js";

const keyForRun = (run) => run.repository + "#" + run.runId;

test("repository scheduler chooses the oldest due time instead of array order", () => {
  const repos = [
    { fullName: "a/early-array", nextPollMs: 5000, lastPollMs: 10 },
    { fullName: "a/unscanned", nextPollMs: 0, lastPollMs: 0 },
    { fullName: "a/overdue", nextPollMs: 1000, lastPollMs: 20 }
  ];
  assert.equal(dueRepository(repos, 6000).fullName, "a/unscanned");
});

test("active detail scheduling is fair across many simultaneously due runs", () => {
  const tracked = Array.from({ length: 20 }, (_, index) => ({
    snapshot: { repository: "repo/" + index, runId: index + 1, state: "in_progress" }
  }));
  const next = new Map(tracked.map((item) => [keyForRun(item.snapshot), 0]));
  const seen = [];

  for (let second = 0; second < 20; second += 1) {
    const now = second * 1000;
    const picked = dueActiveRun(tracked, next, now, keyForRun);
    seen.push(keyForRun(picked.snapshot));
    next.set(keyForRun(picked.snapshot), now + 15000);
  }

  assert.equal(new Set(seen).size, 20);
});

test("repository work cannot be starved by an unlimited active-detail streak", () => {
  const active = { snapshot: { state: "in_progress" } };
  const repo = { fullName: "techrote/repo" };
  assert.equal(shouldServiceActive(active, repo, 0, 3), true);
  assert.equal(shouldServiceActive(active, repo, 2, 3), true);
  assert.equal(shouldServiceActive(active, repo, 3, 3), false);
  assert.equal(shouldServiceActive(active, null, 99, 3), true);
});

test("startup sweep batches preserve queue order and remove serviced entries", () => {
  const repos = ["a", "b", "c", "d"].map((fullName) => ({ fullName }));
  const queue = ["a", "b", "c", "d"];
  const first = takeSweepBatch(queue, repos, 3);
  assert.deepEqual(first.map((repo) => repo.fullName), ["a", "b", "c"]);
  assert.deepEqual(queue, ["d"]);
});
