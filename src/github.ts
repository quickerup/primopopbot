// ---------------------------------------------------------------------------
// GitHub Actions gateway. Mirrors the original Python bot's /gh_* command
// surface, implemented as fetch() calls to the GitHub REST API.
//
// Per spec, the GitHub token is pulled from the factory's own encrypted
// secrets store (secrets:factory -> GITHUB_TOKEN), never from a plain
// wrangler.toml var — same rule the Python original used (GH credentials
// live in the secrets store, not .env), now enforced by construction since
// there's simply no GITHUB_TOKEN field in wrangler.toml [vars].
//
// Requires two more secret fields in the same store: GITHUB_OWNER and
// GITHUB_REPO, set via /set_secret factory GITHUB_OWNER / GITHUB_REPO.
// ---------------------------------------------------------------------------

export interface GhCreds {
  token: string;
  owner: string;
  repo: string;
}

function api(creds: GhCreds, path: string): string {
  return `https://api.github.com/repos/${creds.owner}/${creds.repo}${path}`;
}

async function ghFetch(creds: GhCreds, path: string, init: RequestInit = {}) {
  const res = await fetch(api(creds, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "telegram-bot-factory-worker",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

export async function listWorkflows(creds: GhCreds) {
  const data = (await ghFetch(creds, "/actions/workflows")) as any;
  return (data.workflows as any[]).map((w) => `#${w.id} ${w.name} (${w.state})`).join("\n") || "No workflows found.";
}

export async function dispatchWorkflow(creds: GhCreds, workflow: string, ref = "main") {
  await ghFetch(creds, `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
  return `Dispatched workflow '${workflow}' on ref '${ref}'.`;
}

export async function listRuns(creds: GhCreds, count = 10) {
  const data = (await ghFetch(creds, `/actions/runs?per_page=${count}`)) as any;
  return (
    (data.workflow_runs as any[])
      .map((r) => `#${r.id} ${r.name} — ${r.status}/${r.conclusion ?? "-"} (${r.head_branch})`)
      .join("\n") || "No runs found."
  );
}

export async function getRun(creds: GhCreds, id: string) {
  const r = (await ghFetch(creds, `/actions/runs/${id}`)) as any;
  return `#${r.id} ${r.name}\nStatus: ${r.status}/${r.conclusion ?? "-"}\nBranch: ${r.head_branch}\nURL: ${r.html_url}`;
}

export async function cancelRun(creds: GhCreds, id: string) {
  await ghFetch(creds, `/actions/runs/${id}/cancel`, { method: "POST" });
  return `Cancel requested for run #${id}.`;
}

export async function rerunRun(creds: GhCreds, id: string) {
  await ghFetch(creds, `/actions/runs/${id}/rerun`, { method: "POST" });
  return `Re-run requested for run #${id}.`;
}

export async function getRunLogsUrl(creds: GhCreds, id: string) {
  // GitHub returns a 302 redirect to a signed download URL for the zipped
  // logs; we surface that URL rather than proxying the (often large) zip
  // through the Worker.
  const res = await fetch(api(creds, `/actions/runs/${id}/logs`), {
    method: "GET",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "telegram-bot-factory-worker",
    },
  });
  const location = res.headers.get("location");
  if (!location) throw new Error(`No logs URL returned for run #${id} (status ${res.status})`);
  return `Log archive (expires soon): ${location}`;
}
