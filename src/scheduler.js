export function dueRepository(repositories, nowMs) {
  let best = null;
  for (const repo of repositories) {
    const due = Number(repo.nextPollMs || 0);
    if (due > nowMs) continue;
    if (!best ||
        due < Number(best.nextPollMs || 0) ||
        (due === Number(best.nextPollMs || 0) && Number(repo.lastPollMs || 0) < Number(best.lastPollMs || 0)) ||
        (due === Number(best.nextPollMs || 0) && Number(repo.lastPollMs || 0) === Number(best.lastPollMs || 0) &&
         repo.fullName < best.fullName)) {
      best = repo;
    }
  }
  return best;
}

export function dueActiveRun(trackedRuns, nextByKey, nowMs, keyForRun) {
  let best = null;
  let bestDue = Number.POSITIVE_INFINITY;
  let bestKey = "";
  for (const tracked of trackedRuns) {
    if (tracked.snapshot.state !== "in_progress") continue;
    const key = keyForRun(tracked.snapshot);
    const due = Number(nextByKey.get(key) ?? 0);
    if (due > nowMs) continue;
    if (!best || due < bestDue || (due === bestDue && key < bestKey)) {
      best = tracked;
      bestDue = due;
      bestKey = key;
    }
  }
  return best;
}

export function shouldServiceActive(active, repo, activeDetailStreak, burstLimit = 3) {
  if (!active) return false;
  if (!repo) return true;
  return activeDetailStreak < burstLimit;
}

export function takeSweepBatch(queue, repositories, batchSize) {
  const byName = new Map(repositories.map((repo) => [repo.fullName, repo]));
  const batch = [];
  while (queue.length && batch.length < batchSize) {
    const name = queue.shift();
    const repo = byName.get(name);
    if (repo) batch.push(repo);
  }
  return batch;
}
