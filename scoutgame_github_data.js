// install with: npm install @octokit/rest dotenv
import "dotenv/config";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is not set. Add it to .env or your environment.");
  process.exit(1);
}

const octokit = new Octokit({ auth: token });

const ORG = "GoodDollar";
const REPOS = ["GoodCollective", "GoodSDKs", "GoodProtocolUI", "GoodWeb3-Mono"];

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const since = getArg("--since", "2023-01-01");
const label = getArg("--label", "scouts");
const OUT_DIR = getArg("--out", "output");

function buildSearchQuery() {
  const repoQualifiers = REPOS.map((r) => `repo:${ORG}/${r}`).join(" ");
  // is:issue -> exclude PRs; created:>=since -> creation date window; state both open/closed by default
  // Do NOT include the label qualifier here because we want substring matching on labels, which the API doesn't support.
  return `${repoQualifiers} is:issue created:>=${since}`;
}

async function searchIssuesAllPages(q) {
  const perPage = 100;
  const results = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.search.issuesAndPullRequests({
      q,
      per_page: perPage,
      page,
    });
    results.push(...data.items);
    if (data.items.length < perPage || results.length >= 1000) break; // search API caps at 1000
    page += 1;
  }
  return results;
}

function formatItem(item) {
  const repoFull = item.repository_url.split("/").slice(-2).join("/");
  return {
    repo: repoFull,
    number: item.number,
    title: item.title,
    state: item.state,
    author: item.user?.login,
    labels: item.labels?.map((l) => (typeof l === "string" ? l : l.name)) || [],
    created_at: item.created_at,
    updated_at: item.updated_at,
    url: item.html_url,
  };
}

function parseOwnerRepo(repoFull) {
  const [owner, repo] = repoFull.split("/");
  return { owner, repo };
}

const TIER_MAP = {
  legendary: { usd: 450, g: 4_500_000 },
  mythic: { usd: 350, g: 3_500_000 },
  epic: { usd: 250, g: 2_500_000 },
  rare: { usd: 150, g: 1_500_000 },
  common: { usd: 50, g: 500_000 },
  basic: { usd: 25, g: 250_000 },
};

function deriveBounty(labels = []) {
  const names = labels.map((l) => l.toLowerCase());
  for (const tier of [
    "legendary",
    "mythic",
    "epic",
    "rare",
    "common",
    "basic",
  ]) {
    if (names.some((n) => n.includes(tier))) {
      return { tier, ...TIER_MAP[tier] };
    }
  }
  return { tier: null, usd: 0, g: 0 };
}

async function fetchIssueDetails(issue, labelLower) {
  const { owner, repo } = parseOwnerRepo(issue.repo);
  // Events for label added reference
  let labelAddedAt = null;
  let labelAddedBy = null;
  try {
    const { data: events } = await octokit.issues.listEvents({
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100,
    });
    const labeled = events
      .filter(
        (e) =>
          e.event === "labeled" &&
          e.label?.name?.toLowerCase().includes(labelLower)
      )
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (labeled.length > 0) {
      labelAddedAt = labeled[0].created_at;
      labelAddedBy = labeled[0].actor?.login || null;
    }
  } catch (e) {
    // ignore per-issue failures but record as nulls
  }

  // Comments
  let commentsCount = 0;
  let lastCommentAt = null;
  try {
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issue.number,
      per_page: 100,
    });
    commentsCount = comments.length;
    if (comments.length > 0) {
      lastCommentAt =
        comments[comments.length - 1].updated_at ||
        comments[comments.length - 1].created_at;
    }
  } catch (e) {
    // ignore per-issue failures
  }
  // Timeline cross-references to find PRs that reference this issue via #number in PR description
  // Use explicit Accept header for the timeline preview to ensure `source` is populated consistently.
  let prRefAuthors = [];
  const prRefs = [];
  try {
    const perPage = 100;
    let page = 1;
    const authors = new Set();
    while (true) {
      const { data: timeline } = await octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
        {
          owner,
          repo,
          issue_number: issue.number,
          per_page: perPage,
          page,
          headers: {
            Accept: "application/vnd.github.mockingbird-preview+json",
          },
        }
      );
      for (const ev of timeline) {
        if (ev.event === "cross-referenced" && ev.source) {
          // Typical shape: { type: 'issue', issue: { user, pull_request?, ... } }
          const src = ev.source;
          if (src.type === "issue" && src.issue && src.issue.pull_request) {
            const a = src.issue.user?.login;
            if (a) authors.add(a);
            // collect PR ref {owner, repo, number}
            const repoUrl = src.issue.repository_url;
            const parts = String(repoUrl || "").split("/");
            const prOwner = parts[parts.length - 2];
            const prRepo = parts[parts.length - 1];
            const prNumber = src.issue.number;
            if (prOwner && prRepo && prNumber) {
              prRefs.push({ owner: prOwner, repo: prRepo, number: prNumber });
            }
          }
        }
      }
      if (!Array.isArray(timeline) || timeline.length < perPage) break;
      page += 1;
    }
    prRefAuthors = Array.from(authors);
  } catch (e) {
    // ignore; timeline may be unavailable
  }

  // derive PRState by querying each referenced PR
  let prState = "none";
  if (prRefs.length) {
    let anyMerged = false;
    let anyOpen = false;
    let anyClosed = false;
    for (const ref of prRefs) {
      try {
        const { data: pr } = await octokit.pulls.get({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
        });
        if (pr.merged) anyMerged = true;
        else if (pr.state === "open") anyOpen = true;
        else if (pr.state === "closed") anyClosed = true;
      } catch (e) {
        // ignore inaccessible PRs
      }
    }
    prState = anyMerged ? "merged" : anyOpen ? "open" : anyClosed ? "closed" : "none";
  }

  return {
    labelAddedAt,
    labelAddedBy,
    commentsCount,
    lastCommentAt,
    prRefAuthors,
    prState,
  };
}

(async () => {
  try {
    const q = buildSearchQuery();
    const items = await searchIssuesAllPages(q);
    const labelLower = label.toLowerCase();
    const filtered = items.filter((it) =>
      (it.labels || []).some((l) => {
        const name = typeof l === "string" ? l : l.name;
        return name?.toLowerCase().includes(labelLower);
      })
    );
    const formattedBase = filtered.map(formatItem);

    // Enrich with bounty + events + comments
    const enriched = [];
    for (const base of formattedBase) {
      const bounty = deriveBounty(base.labels);
      const details = await fetchIssueDetails(base, labelLower);
      enriched.push({ ...base, bounty, ...details });
    }

    // Partition: Future Scouts Game items to separate tab
    const isFutureScouts = (it) =>
      (it.labels || []).some((l) => {
        const name = typeof l === "string" ? l : l?.name ?? "";
        return (
          String(name).toLowerCase() === "future scouts game".toLowerCase()
        );
      });
    const futureScoutsItems = enriched.filter(isFutureScouts);
    const mainItems = enriched.filter((it) => !isFutureScouts(it));

    // Group by repo for readability (main items only)
    const byRepo = mainItems.reduce((acc, it) => {
      acc[it.repo] = acc[it.repo] || [];
      acc[it.repo].push(it);
      return acc;
    }, {});

    // Open/Closed collections sorted by updated_at desc
    // Treat PRState 'merged' as closed for categorization.
    const isClosedLike = (i) => i.state === "closed" || i.prState === "merged";
    const openItems = mainItems
      .filter((i) => !isClosedLike(i))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const closedItems = mainItems
      .filter((i) => isClosedLike(i))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    // Aggregates overall and per-repo
    function sumAgg(items) {
      return items.reduce(
        (acc, it) => {
          acc.count += 1;
          acc.usd += it.bounty.usd || 0;
          acc.g += it.bounty.g || 0;
          return acc;
        },
        { count: 0, usd: 0, g: 0 }
      );
    }
    const aggregates = {
      overall: {
        open: sumAgg(openItems),
        closed: sumAgg(closedItems),
      },
      byRepo: Object.fromEntries(
        Object.entries(byRepo).map(([repo, items]) => {
          const openR = items.filter((i) => !(i.state === "closed" || i.prState === "merged"));
          const closedR = items.filter((i) => i.state === "closed" || i.prState === "merged");
          return [repo, { open: sumAgg(openR), closed: sumAgg(closedR) }];
        })
      ),
    };

    const payload = {
      query: q,
      since,
      labelContains: label,
      total: mainItems.length,
      generated_at: new Date().toISOString(),
      byRepo,
      openItems,
      closedItems,
      futureScoutsItems,
      aggregates,
    };

    // Write JSON + HTML outputs
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const jsonPath = path.join(OUT_DIR, "scout_issues.json");
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

    const htmlPath = path.join(OUT_DIR, "index.html");
    const html = buildHtml(payload);
    fs.writeFileSync(htmlPath, html, "utf8");

    console.log(
      JSON.stringify(
        { out: { json: jsonPath, html: htmlPath }, total: payload.total },
        null,
        2
      )
    );
  } catch (err) {
    console.error("Error while searching issues:", err?.message || err);
    process.exit(1);
  }
})();

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildHtmlOld(data) {
  const repos = Object.keys(data.byRepo);
  const header = `
    <header>
      <h1>Scout-Labeled Issues</h1>
      <div class="meta">
        <div><strong>Org:</strong> ${escapeHtml(ORG)}</div>
        <div><strong>Repos:</strong> ${repos.length}</div>
        <div><strong>Since:</strong> ${escapeHtml(data.since)}</div>
        <div><strong>Label contains:</strong> ${escapeHtml(
          data.labelContains
        )}</div>
        <div><strong>Total:</strong> ${data.total}</div>
        <div><strong>Generated:</strong> ${escapeHtml(data.generated_at)}</div>
      </div>
    </header>`;

  const sections = repos
    .map((repo) => {
      const items = data.byRepo[repo];
      const rows = items
        .map((it) => {
          const labelsHtml = it.labels
            .map((l) => `<span class="label">${escapeHtml(l)}</span>`)
            .join(" ");
          return `
            <tr>
              <td class="repo">${escapeHtml(repo)}</td>
              <td class="num">#${it.number}</td>
              <td class="title"><a href="${escapeHtml(
                it.url
              )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            it.title
          )}</a></td>
              <td class="state ${it.state}">${escapeHtml(it.state)}</td>
              <td class="author">${escapeHtml(it.author || "-")}</td>
              <td class="created">${escapeHtml(it.created_at)}</td>
              <td class="labels">${labelsHtml}</td>
            </tr>`;
        })
        .join("\n");
      return `
        <section>
          <h2>${escapeHtml(repo)} <span class="count">(${
        items.length
      })</span></h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>#</th>
                  <th>Title</th>
                  <th>State</th>
                  <th>Author</th>
                  <th>Created</th>
                  <th>Labels</th>
                </tr>
              </thead>
              <tbody>
                ${
                  rows ||
                  "<tr><td colspan=7 class=empty>No issues found.</td></tr>"
                }
              </tbody>
            </table>
          </div>
        </section>`;
    })
    .join("\n");

  const css = `
    :root { --bg:#0b1220; --card:#121a2a; --text:#e6edf3; --muted:#9fb1c1; --accent:#60a5fa; --border:#20304a; --label:#1f2937; --open:#16a34a; --closed:#dc2626; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; background: linear-gradient(180deg, rgba(11,18,32,0.95), rgba(11,18,32,0.7)); backdrop-filter: blur(6px); border-bottom: 1px solid var(--border); padding: 16px; z-index: 10; }
    header h1 { margin: 0 0 6px; font-size: 20px; }
    header .meta { display: flex; flex-wrap: wrap; gap: 12px 18px; color: var(--muted); }
    main { padding: 16px; max-width: 1500px; margin: 0 auto; }
    section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin: 16px 0; overflow: hidden; }
    section h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: rgba(96,165,250,0.12); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
    section h2 .count { color: var(--muted); font-weight: 600; }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
    tbody td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tbody tr:hover { background: rgba(96,165,250,0.06); }
    td.repo { color: var(--muted); white-space: nowrap; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.title a { color: var(--text); text-decoration: none; }
    td.title a:hover { color: var(--accent); text-decoration: underline; }
    td.state { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .4px; }
    td.state.open { color: var(--open); }
    td.state.closed { color: var(--closed); }
    .label { display: inline-block; padding: 3px 7px; font-size: 12px; border-radius: 999px; background: var(--label); color: var(--text); border: 1px solid var(--border); }
    .empty { text-align: center; color: var(--muted); padding: 14px; }
    footer { text-align: center; color: var(--muted); padding: 24px 12px; }
  `;

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Scout Issues Viewer</title>
      <style>${css}</style>
    </head>
    <body>
      ${header}
      <main>
        ${
          sections ||
          `<section><h2>Results</h2><div class="empty">No issues found.</div></section>`
        }
      </main>
      <footer>Generated from GitHub Search API • ${escapeHtml(
        new Date().toLocaleString()
      )}</footer>
    </body>
  </html>`;
}

// New UI with tabs, bounty amounts, aggregates, and label-added/comment metadata
function buildHtml(data) {
  const repos = Object.keys(data.byRepo);
  const fmtUsd = (n) =>
    `$${(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtG = (n) =>
    `${(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} G$`;
  const tierOrder = ["basic", "common", "rare", "epic", "mythic", "legendary"];
  const tierLabel = (t) => `${t[0].toUpperCase()}${t.slice(1)}`;
  const mainItems = [...data.openItems, ...data.closedItems];
  const excludedContributors = new Set(["l03tj3", "sirpy"]);
  const contributors = Array.from(
    new Set(
      mainItems.flatMap((it) =>
        it.prRefAuthors && it.prRefAuthors.length ? it.prRefAuthors : []
      )
    )
  )
    .filter((name) => !excludedContributors.has(String(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const ticketsClosedCount = data.closedItems.length;
  const inProgressItems = mainItems.filter((it) => {
    const prState = it.prState || "none";
    return it.state === "open" && prState !== "merged";
  });
  const rewardEligibleItems = mainItems.filter((it) => {
    const prState = it.prState || "none";
    return prState === "merged" || (it.state === "closed" && prState !== "none");
  });
  const defaultBounty = { tier: "basic", ...TIER_MAP.basic };
  const effectiveBounty = (it) => (it.bounty?.tier ? it.bounty : defaultBounty);
  const rewardAgg = {
    total: { count: 0, usd: 0, g: 0 },
    byTier: Object.fromEntries(
      tierOrder.map((tier) => [tier, { count: 0, usd: 0, g: 0 }])
    ),
  };
  for (const it of rewardEligibleItems) {
    const bounty = effectiveBounty(it);
    const tier = bounty.tier || "basic";
    rewardAgg.byTier[tier].count += 1;
    rewardAgg.byTier[tier].usd += bounty.usd || 0;
    rewardAgg.byTier[tier].g += bounty.g || 0;
    rewardAgg.total.count += 1;
    rewardAgg.total.usd += bounty.usd || 0;
    rewardAgg.total.g += bounty.g || 0;
  }

  const isRewardEligible = (it) => {
    const prState = it.prState || "none";
    return prState === "merged" || (it.state === "closed" && prState !== "none");
  };

  const contributorMap = new Map();
  const getContributor = (it) => {
    const authors = Array.isArray(it.prRefAuthors) ? it.prRefAuthors : [];
    if (!authors.length) return null;
    const last = authors[authors.length - 1];
    if (!last) return null;
    if (excludedContributors.has(String(last).toLowerCase())) return null;
    return last;
  };
  for (const it of mainItems) {
    const name = getContributor(it);
    if (!name) continue;
    if (!contributorMap.has(name)) {
      contributorMap.set(name, {
        name,
        tickets: [],
        rewards: { count: 0, usd: 0, g: 0 },
      });
    }
    const entry = contributorMap.get(name);
    entry.tickets.push(it);
    if (isRewardEligible(it)) {
      const bounty = effectiveBounty(it);
      entry.rewards.count += 1;
      entry.rewards.usd += bounty.usd || 0;
      entry.rewards.g += bounty.g || 0;
    }
  }
  const contributorEntries = Array.from(contributorMap.values()).sort((a, b) => {
    if (b.rewards.usd !== a.rewards.usd) return b.rewards.usd - a.rewards.usd;
    if (b.rewards.g !== a.rewards.g) return b.rewards.g - a.rewards.g;
    if (b.rewards.count !== a.rewards.count) return b.rewards.count - a.rewards.count;
    return a.name.localeCompare(b.name);
  });

  const header = `
    <header>
      <h1>Scout-Labeled Issues</h1>
      <div class="meta">
        <div><strong>Org:</strong> ${escapeHtml(ORG)}</div>
        <div><strong>Repos:</strong> ${repos.length}</div>
        <div><strong>Since:</strong> ${escapeHtml(data.since)}</div>
        <div><strong>Label contains:</strong> ${escapeHtml(
          data.labelContains
        )}</div>
        <div><strong>Total:</strong> ${data.total}</div>
        <div><strong>Generated:</strong> ${escapeHtml(data.generated_at)}</div>
      </div>
      <nav class="tabs">
        <button data-tab="open" class="active">Open</button>
        <button data-tab="closed">Closed</button>
        <button data-tab="byrepo">By Repo</button>
        <button data-tab="aggregates">Aggregates</button>
        <button data-tab="futurescouts">Future Scouts</button>
      </nav>
      <div class="header-actions">
        <button class="report-btn" id="report-btn" type="button">Generate Report</button>
      </div>
    </header>`;

  function issueRow(repo, it, { includeRepo = false } = {}) {
    const labelsHtml = (it.labels || [])
      .map((l) => `<span class="label">${escapeHtml(l)}</span>`)
      .join(" ");
    const bountyText = it.bounty?.tier
      ? `${it.bounty.tier[0].toUpperCase()}${it.bounty.tier.slice(
          1
        )} — ${fmtUsd(it.bounty.usd)} | ${fmtG(it.bounty.g)}`
      : "-";
    const commentsText = `${it.commentsCount || 0}`;
    const prAuthors =
      it.prRefAuthors && it.prRefAuthors.length
        ? it.prRefAuthors.map(escapeHtml).join(", ")
        : "-";
    const updatedDay = it.updated_at ? new Date(it.updated_at).toISOString().slice(0,10) : "-";
    const issueDisplay = it.prState === "merged" && it.state !== "closed" ? "In Review" : it.state;
    const issueClass = it.prState === "merged" && it.state !== "closed" ? "in-review" : it.state;
    return `
      <tr>
        ${includeRepo ? `<td class="repo">${escapeHtml(repo)}</td>` : ""}
        <td class="title"><a href="${escapeHtml(
          it.url
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
      it.title
    )}</a></td>
        <td class="state ${issueClass}">${escapeHtml(issueDisplay)}</td>
        <td class="pr-state">${escapeHtml(it.prState || "none")}</td>
        <td class="author">${escapeHtml(it.author || "-")}</td>
        <td class="updated">${escapeHtml(updatedDay)}</td>
        <td class="bounty">${bountyText}</td>
        <td class="comments">${commentsText}</td>
        <td class="pr-authors">${prAuthors}</td>
        <td class="labels">${labelsHtml}</td>
      </tr>`;
  }

  function issuesTable(items) {
    const rows = items
      .map((it) => issueRow(it.repo, it, { includeRepo: true }))
      .join("");
    return `
      <section>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Title</th>
                <th>IssueState</th>
                <th>PRState</th>
                <th>CreatedBy</th>
                <th>Updated (day)</th>
                <th>Bounty</th>
                <th>Comments</th>
                <th>PR Ref Authors</th>
                <th>Labels</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows ||
                `<tr><td colspan=10 class=empty>No issues found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>`;
  }

  const byRepoSections = repos
    .map((repo) => {
      const items = data.byRepo[repo];
      const rows = items
        .map((it) => issueRow(repo, it, { includeRepo: true }))
        .join("\n");
      return `
        <section>
          <h2>${escapeHtml(repo)} <span class="count">(${
        items.length
      })</span></h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Title</th>
                  <th>IssueState</th>
                  <th>PRState</th>
                  <th>CreatedBy</th>
                  <th>Updated (day)</th>
                  <th>Bounty</th>
                  <th>Comments</th>
                  <th>PR Ref Authors</th>
                  <th>Labels</th>
                </tr>
              </thead>
              <tbody>
                ${
                  rows ||
                  "<tr><td colspan=10 class=empty>No issues found.</td></tr>"
                }
              </tbody>
            </table>
          </div>
        </section>`;
    })
    .join("\n");

  function aggCard(title, agg) {
    return `
      <div class="agg-card">
        <div class="agg-title">${title}</div>
        <div class="agg-line"><span>Count</span><b>${agg.count}</b></div>
        <div class="agg-line"><span>USD</span><b>${fmtUsd(agg.usd)}</b></div>
        <div class="agg-line"><span>G$</span><b>${fmtG(agg.g)}</b></div>
      </div>`;
  }

  const openAgg = aggCard("Open Total", data.aggregates.overall.open);
  const closedAgg = aggCard("Closed Total", data.aggregates.overall.closed);
  const openTable = issuesTable(data.openItems);
  const closedTable = issuesTable(data.closedItems);

  const aggregatesTable = `
    <section>
      <h2>Aggregates by Repo</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Open Count</th>
              <th>Open USD</th>
              <th>Open G$</th>
              <th>Closed Count</th>
              <th>Closed USD</th>
              <th>Closed G$</th>
            </tr>
          </thead>
          <tbody>
            ${repos
              .map((r) => {
                const a = data.aggregates.byRepo[r];
                return `
                  <tr>
                    <td class="repo">${escapeHtml(r)}</td>
                    <td>${a.open.count}</td>
                    <td>${fmtUsd(a.open.usd)}</td>
                    <td>${fmtG(a.open.g)}</td>
                    <td>${a.closed.count}</td>
                    <td>${fmtUsd(a.closed.usd)}</td>
                    <td>${fmtG(a.closed.g)}</td>
                  </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="agg-wrap">
        ${openAgg}
        ${closedAgg}
      </div>
    </section>`;

  function reportIssueRow(it) {
    const updatedDay = it.updated_at
      ? new Date(it.updated_at).toISOString().slice(0, 10)
      : "-";
    return `
      <tr>
        <td class="repo">${escapeHtml(it.repo)}</td>
        <td class="title"><a href="${escapeHtml(
          it.url
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
      it.title
    )}</a></td>
        <td>${escapeHtml(updatedDay)}</td>
        <td>${escapeHtml(it.prState || "none")}</td>
      </tr>`;
  }

  const contributorList =
    contributors.length > 0
      ? contributors
          .map((name) => `<span class="report-pill">${escapeHtml(name)}</span>`)
          .join("")
      : `<span class="muted">No PR references found yet.</span>`;

  const maxTierCount = Math.max(
    1,
    ...tierOrder.map((t) => rewardAgg.byTier[t].count || 0)
  );
  const rewardTierRows = tierOrder
    .map((tier) => {
      const agg = rewardAgg.byTier[tier];
      const pct = ((agg.count || 0) / maxTierCount) * 100;
      return `
        <tr>
          <td>${tierLabel(tier)}</td>
          <td class="num">${agg.count}</td>
          <td class="num">${fmtUsd(agg.usd)}</td>
          <td class="num">${fmtG(agg.g)}</td>
          <td>
            <div class="report-bar">
              <span style="width:${pct.toFixed(2)}%"></span>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  const contributorRewardRows = contributorEntries
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.name)}</td>
          <td class="num">${entry.tickets.length}</td>
          <td class="num">${entry.rewards.count}</td>
          <td class="num">${fmtUsd(entry.rewards.usd)}</td>
          <td class="num">${fmtG(entry.rewards.g)}</td>
        </tr>`
    )
    .join("");

  const contributorTicketBlocks = contributorEntries
    .map((entry) => {
      const items = entry.tickets
        .slice()
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      const listItems = items
        .map((it) => {
          const updated = it.updated_at
            ? new Date(it.updated_at).toISOString().slice(0, 10)
            : "-";
          const prState = it.prState || "none";
          return `
            <li>
              <span class="ticket-repo">${escapeHtml(it.repo)}</span>
              <a href="${escapeHtml(
                it.url
              )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            it.title
          )}</a>
              <span class="ticket-meta">${escapeHtml(
                it.state
              )} · pr: ${escapeHtml(prState)} · ${escapeHtml(updated)}</span>
            </li>`;
        })
        .join("");
      return `
        <div class="report-ticket-block">
          <h4>${escapeHtml(entry.name)} <span class="muted">(${items.length})</span></h4>
          <ul class="report-ticket-list">
            ${
              listItems ||
              `<li class="muted">No referenced tickets.</li>`
            }
          </ul>
        </div>`;
    })
    .join("");

  const inProgressRows = inProgressItems.map(reportIssueRow).join("");
  const inProgressTable = `
    <section class="report-section">
      <h3>Tickets Still In Progress</h3>
      <div class="report-subtext">Open issues with no merged PR.</div>
      <div class="table-wrap report-table">
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Title</th>
              <th>Updated</th>
              <th>PR State</th>
            </tr>
          </thead>
          <tbody>
            ${
              inProgressRows ||
              `<tr><td colspan="4" class="empty">No open in-progress issues.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>`;

  const reportHtml = `
    <div class="report-card" role="dialog" aria-modal="true" aria-labelledby="report-title">
      <div class="report-header">
        <div>
          <div class="report-kicker">Scout Issues Report</div>
          <h2 id="report-title">Overview</h2>
          <div class="report-meta">
            <span>Org: ${escapeHtml(ORG)}</span>
            <span>Since: ${escapeHtml(data.since)}</span>
            <span>Label: ${escapeHtml(data.labelContains)}</span>
            <span>Generated: ${escapeHtml(data.generated_at)}</span>
          </div>
        </div>
        <div class="report-actions">
          <button class="report-btn" id="report-print" type="button">Download PDF</button>
          <button class="report-btn ghost" id="report-close" type="button">Close</button>
        </div>
      </div>
      <section class="report-section">
        <div class="report-grid">
          <div class="report-metric">
            <div class="report-metric-label">Contributors Participated</div>
            <div class="report-metric-value">${contributors.length}</div>
          </div>
          <div class="report-metric">
            <div class="report-metric-label">Tickets Closed</div>
            <div class="report-metric-value">${ticketsClosedCount}</div>
          </div>
          <div class="report-metric">
            <div class="report-metric-label">Rewards Distributed</div>
            <div class="report-metric-value">${fmtUsd(
              rewardAgg.total.usd
            )} | ${fmtG(rewardAgg.total.g)}</div>
            <div class="report-metric-subtext">${rewardAgg.total.count} eligible tickets</div>
          </div>
          <div class="report-metric">
            <div class="report-metric-label">Open In Progress</div>
            <div class="report-metric-value">${inProgressItems.length}</div>
          </div>
        </div>
      </section>
      <section class="report-section">
        <h3>Contributors Participated</h3>
        <div class="report-subtext">Based on PR reference authors.</div>
        <div class="report-pill-wrap">${contributorList}</div>
      </section>
      <section class="report-section">
        <h3>Rewards Distributed</h3>
        <div class="report-subtext">Merged PRs or closed issues with connected PRs. Unlabeled defaults to Basic.</div>
        <div class="table-wrap report-table">
          <table>
            <thead>
              <tr>
                <th>Tier</th>
                <th>Tickets</th>
                <th>USD</th>
                <th>G$</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              ${rewardTierRows}
            </tbody>
          </table>
        </div>
      </section>
      <section class="report-section">
        <h3>Contributor Rewards</h3>
        <div class="report-subtext">Attribution uses the last PR reference author per ticket. Contributors excluded: L03TJ3, sirpy.</div>
        <div class="table-wrap report-table">
          <table>
            <thead>
              <tr>
                <th>Contributor</th>
                <th>Tickets</th>
                <th>Rewarded Tickets</th>
                <th>USD</th>
                <th>G$</th>
              </tr>
            </thead>
            <tbody>
              ${
                contributorRewardRows ||
                `<tr><td colspan="5" class="empty">No contributor rewards available.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
      <section class="report-section">
        <h3>Tickets Picked Up</h3>
        <div class="report-subtext">All referenced tickets, grouped by contributor.</div>
        <div class="report-ticket-grid">
          ${
            contributorTicketBlocks ||
            `<div class="muted">No contributor ticket assignments found.</div>`
          }
        </div>
      </section>
      ${inProgressTable}
    </div>`;

  const css = `
    :root { --bg:#0b1220; --card:#121a2a; --text:#e6edf3; --muted:#9fb1c1; --accent:#60a5fa; --border:#20304a; --label:#1f2937; --open:#16a34a; --closed:#dc2626; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); }
    header { position: sticky; top: 0; background: linear-gradient(180deg, rgba(11,18,32,0.95), rgba(11,18,32,0.7)); backdrop-filter: blur(6px); border-bottom: 1px solid var(--border); padding: 16px; z-index: 10; }
    header h1 { margin: 0 0 6px; font-size: 20px; }
    header .meta { display: flex; flex-wrap: wrap; gap: 12px 18px; color: var(--muted); }
    .tabs { display: flex; gap: 8px; margin-top: 10px; }
    .tabs button { background: transparent; color: var(--text); border: 1px solid var(--border); padding: 6px 10px; border-radius: 8px; cursor: pointer; }
    .tabs button.active { background: rgba(96,165,250,0.18); border-color: var(--accent); }
    main { padding: 16px; max-width: 1500px; margin: 0 auto; }
    section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin: 16px 0; overflow: hidden; }
    section h2 { margin: 0; padding: 12px 14px; font-size: 16px; background: rgba(96,165,250,0.12); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
    section h2 .count { color: var(--muted); font-weight: 600; }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); white-space: nowrap; }
    tbody td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tbody tr:hover { background: rgba(96,165,250,0.06); }
    td.repo { color: var(--muted); white-space: nowrap; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.title a { color: var(--text); text-decoration: none; }
    td.title a:hover { color: var(--accent); text-decoration: underline; }
    td.state { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .4px; }
    td.state.open { color: var(--open); }
    td.state.closed { color: var(--closed); }
    td.state.in-review { color: var(--accent); }
    .label { display: inline-block; padding: 3px 7px; font-size: 12px; border-radius: 999px; background: var(--label); color: var(--text); border: 1px solid var(--border); }
    .muted { color: var(--muted); }
    .empty { text-align: center; color: var(--muted); padding: 14px; }
    .agg-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
    .agg-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
    .agg-title { font-weight: 700; margin-bottom: 6px; }
    .agg-line { display: flex; align-items: center; justify-content: space-between; color: var(--muted); }
    footer { text-align: center; color: var(--muted); padding: 24px 12px; }
    .screen { display: none; }
    .screen.active { display: block; }
    .header-actions { margin-top: 10px; }
    .report-btn { background: var(--accent); color: #0b1220; border: 1px solid var(--accent); padding: 8px 12px; border-radius: 8px; cursor: pointer; font-weight: 600; }
    .report-btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
    .report-modal { position: fixed; inset: 0; background: rgba(3, 7, 18, 0.72); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 30; }
    .report-modal.active { display: flex; }
    .report-card { width: min(920px, 100%); max-height: 90vh; overflow: auto; background: #ffffff; color: #111827; border-radius: 16px; padding: 24px; box-shadow: 0 24px 64px rgba(0,0,0,0.4); }
    .report-header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 16px; }
    .report-kicker { text-transform: uppercase; letter-spacing: .12em; font-size: 11px; color: #6b7280; }
    .report-meta { display: flex; flex-wrap: wrap; gap: 10px 16px; color: #6b7280; font-size: 12px; margin-top: 6px; }
    .report-actions { display: flex; gap: 8px; align-items: flex-start; }
    .report-section { margin: 18px 0; }
    .report-section h3 { margin: 0 0 6px; font-size: 14px; color: #111827; }
    .report-subtext { color: #6b7280; font-size: 12px; margin-bottom: 10px; }
    .report-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .report-metric { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #f9fafb; }
    .report-metric-label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .report-metric-value { font-size: 18px; font-weight: 700; margin-top: 6px; }
    .report-metric-subtext { color: #6b7280; font-size: 12px; margin-top: 4px; }
    .report-pill-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
    .report-pill { background: #e5e7eb; color: #111827; border-radius: 999px; padding: 4px 8px; font-size: 12px; }
    .report-table table { border-collapse: collapse; width: 100%; }
    .report-table th { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    .report-table td { padding: 8px 10px; border-bottom: 1px solid #f3f4f6; }
    .report-table a { color: inherit; text-decoration: none; }
    .report-table a:hover { text-decoration: underline; }
    .report-bar { width: 120px; height: 8px; background: #e5e7eb; border-radius: 999px; overflow: hidden; }
    .report-bar span { display: block; height: 100%; background: #2563eb; border-radius: inherit; }
    .report-ticket-grid { display: grid; gap: 12px; }
    .report-ticket-block { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #f9fafb; }
    .report-ticket-block h4 { margin: 0 0 8px; font-size: 13px; color: #111827; }
    .report-ticket-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
    .report-ticket-list li { display: grid; gap: 2px; }
    .report-ticket-list a { color: #111827; text-decoration: none; }
    .report-ticket-list a:hover { text-decoration: underline; }
    .ticket-repo { font-size: 12px; color: #6b7280; }
    .ticket-meta { font-size: 11px; color: #6b7280; }
    body.report-open { overflow: hidden; }
    @media print {
      body { background: #ffffff; color: #111827; }
      header, main, footer { display: none !important; }
      body.report-open .report-modal { position: static; inset: auto; padding: 0; background: none; display: block !important; }
      .report-card { box-shadow: none; border-radius: 0; padding: 0; max-height: none; }
      .report-actions { display: none !important; }
    }
  `;

  const script = `
    const tabs = document.querySelectorAll('nav.tabs button');
    const screens = document.querySelectorAll('.screen');
    tabs.forEach(btn => btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-tab');
      screens.forEach(sc => sc.classList.toggle('active', sc.id === target));
    }));
    const reportBtn = document.getElementById('report-btn');
    const reportModal = document.getElementById('report-modal');
    const reportClose = document.getElementById('report-close');
    const reportPrint = document.getElementById('report-print');
    if (reportBtn && reportModal) {
      const openReport = () => {
        reportModal.classList.add('active');
        document.body.classList.add('report-open');
        reportModal.setAttribute('aria-hidden', 'false');
      };
      const closeReport = () => {
        reportModal.classList.remove('active');
        document.body.classList.remove('report-open');
        reportModal.setAttribute('aria-hidden', 'true');
      };
      reportBtn.addEventListener('click', openReport);
      reportClose && reportClose.addEventListener('click', closeReport);
      reportModal.addEventListener('click', (e) => {
        if (e.target === reportModal) closeReport();
      });
      reportPrint && reportPrint.addEventListener('click', () => window.print());
    }
  `;

  const byRepoView =
    byRepoSections ||
    `<section><h2>By Repo</h2><div class=\"empty\">No issues found.</div></section>`;

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Scout Issues Viewer</title>
      <style>${css}</style>
    </head>
    <body>
      ${header}
      <main>
        <div id="open" class="screen active">
          <section><h2>Open (sorted by updated_at desc)</h2><div class="agg-wrap">${openAgg}</div></section>
          ${openTable}
        </div>
        <div id="closed" class="screen">
          <section><h2>Closed (sorted by updated_at desc)</h2><div class="agg-wrap">${closedAgg}</div></section>
          ${closedTable}
        </div>
        <div id="byrepo" class="screen">${byRepoView}</div>
        <div id="futurescouts" class="screen">
          <section><h2>Future Scouts Game</h2></section>
          ${issuesTable(data.futureScoutsItems || [])}
        </div>
        <div id="aggregates" class="screen">${aggregatesTable}</div>
      </main>
      <footer>Generated from GitHub Search API • ${escapeHtml(
        new Date().toLocaleString()
      )}</footer>
      <div id="report-modal" class="report-modal" aria-hidden="true">
        ${reportHtml}
      </div>
      <script>${script}</script>
    </body>
  </html>`;
}
