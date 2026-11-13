// Test-only Node preload. The real server, tracker, scheduler, persistence and
// HTTP routes run unchanged; only GitHub's external transport is deterministic.
// Never loaded by npm start or a production configuration setting.
import { readFile, appendFile } from "node:fs/promises";

const fixturePath = process.env.CISMON_BROWSER_FIXTURE;
if (!fixturePath) throw new Error("Browser provider fixture requires CISMON_BROWSER_FIXTURE");
const originalFetch = globalThis.fetch;
globalThis.fetch = async function fixtureFetch(input, options) {
  const url = new URL(String(input));
  if (url.origin !== "https://api.github.com") return originalFetch(input, options);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const pathname = url.pathname;
  const repository = fixture.repository;
  const prefix = "/repos/" + repository;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const perPage = Number(url.searchParams.get("per_page")) || 100;
  const slice = values => values.slice((page - 1) * perPage, page * perPage);
  let status = 200, body;
  const denied = (fixture.denied || []).find(value => pathname.includes(value));
  if (denied) { status = 403; body = { message: "Resource not accessible by personal access token" }; }
  else if (pathname === "/user/repos") body = [{ full_name: repository, pushed_at: new Date().toISOString() }];
  else if (pathname === prefix + "/branches/main") body = {
    name: "main", protected: false,
    protection: { required_status_checks: { contexts: [], checks: [] } }
  };
  else if (pathname === prefix + "/rules/branches/main") body = fixture.rules || [];
  else if (pathname === prefix + "/actions/runs") {
    const sha = url.searchParams.get("head_sha");
    const runs = fixture.runs.filter(run => !sha || run.head_sha === sha);
    body = { total_count: runs.length, workflow_runs: slice(runs) };
  } else if (new RegExp("^" + prefix + "/actions/runs/\\d+(?:/attempts/\\d+)?$").test(pathname)) {
    const [, id, attempt] = pathname.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/);
    const run = fixture.runs.find(run => run.id === Number(id) && (!attempt || run.run_attempt === Number(attempt))) ||
      fixture.oldAttempts?.find(run => run.id === Number(id) && run.run_attempt === Number(attempt));
    if (run) body = run;
    else { status = 404; body = { message: "Not Found" }; }
  } else if (new RegExp("^" + prefix + "/actions/runs/\\d+(?:/attempts/\\d+)?/jobs$").test(pathname)) {
    const [, id, attempt] = pathname.match(/\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/jobs$/);
    const run = [...fixture.runs, ...(fixture.oldAttempts || [])].find(run => run.id === Number(id) &&
      (!attempt || run.run_attempt === Number(attempt)));
    if (!run) { status = 404; body = { message: "Not Found" }; }
    else {
      const jobs = fixture.jobs?.[id + "@" + (attempt || run.run_attempt)] || [{
        id: run.id * 10 + run.run_attempt, run_id: run.id, name: "Build fixture",
        status: run.status, conclusion: run.conclusion, started_at: run.run_started_at,
        completed_at: run.status === "completed" ? run.updated_at : null,
        runner_id: run.status === "in_progress" ? run.id : 0, steps: []
      }];
      body = { total_count: jobs.length, jobs: slice(jobs) };
    }
  } else if (pathname.startsWith(prefix + "/pulls/")) {
    const number = Number(pathname.split("/").at(-1));
    body = fixture.prs.find(pr => pr.number === number);
    if (!body) { status = 404; body = { message: "Not Found" }; }
  } else if (pathname.startsWith(prefix + "/commits/")) {
    const [, sha, endpoint] = pathname.match(/\/commits\/([^/]+)\/(.+)$/) || [];
    const relevant = fixture.checks?.[sha] || {};
    if (endpoint === "pulls") body = slice(fixture.prs.filter(pr => pr.head.sha === sha || pr.merge_commit_sha === sha));
    else if (endpoint === "check-suites") {
      const suites = relevant.suites || [];
      body = { total_count: relevant.suiteCount ?? suites.length, check_suites: slice(suites) };
    } else if (endpoint === "check-runs") {
      const checks = relevant.runs || [];
      body = { total_count: relevant.checkCount ?? checks.length, check_runs: slice(checks) };
    } else if (endpoint === "status") {
      const statuses = relevant.statuses || [];
      body = { sha, total_count: statuses.length, statuses: slice(statuses),
        state: statuses.some(item => item.state === "pending") ? "pending" :
          statuses.some(item => ["failure", "error"].includes(item.state)) ? "failure" : "success" };
    }
  }
  if (body === undefined) { status = 404; body = { message: "Fixture does not implement " + pathname }; }
  if (process.env.CISMON_BROWSER_REQUEST_LOG) {
    await appendFile(process.env.CISMON_BROWSER_REQUEST_LOG, JSON.stringify({ at: Date.now(), pathname, search: url.search, status }) + "\n");
  }
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "X-RateLimit-Remaining": "4500", "X-RateLimit-Reset": "0"
  } });
};
