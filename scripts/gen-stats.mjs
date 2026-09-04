// Generates stats.html for sawiyya.com/stats, a live analytics page.
// Runs in GitHub Actions on a schedule. Reads PostHog via the query API.
// Needs env POSTHOG_API_KEY (a PostHog personal API key with query:read).
// If the key is absent it exits 0 without writing, so the workflow stays green
// until the secret is added.
//
// The headline numbers are ALL TIME, with the last 30 days as a second line.
// The page used to show only a rolling 30-day window, so when the June/July
// visits aged out on 2026-08-03 it read three zeros and looked broken.
//
// Local preview without a PostHog key:
//   STATS_FIXTURE=scripts/fixtures/quiet.json node scripts/gen-stats.mjs
import { writeFileSync, readFileSync } from "node:fs";

const KEY = process.env.POSTHOG_API_KEY;
const FIXTURE = process.env.STATS_FIXTURE;
const PROJECT = process.env.POSTHOG_PROJECT_ID || "148422";
const HOST = process.env.POSTHOG_HOST || "https://eu.posthog.com";

if (!KEY && !FIXTURE) {
  console.log("No POSTHOG_API_KEY set, skipping stats generation (workflow stays green).");
  process.exit(0);
}

async function hogql(query) {
  const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results || [];
}

const HOSTFILTER = "properties.$host ILIKE '%sawiyya.com%'";
const WINDOW = "timestamp > now() - INTERVAL 30 DAY";

const TOTALS = (where) => `
  SELECT
    countIf(event = '$pageview') AS views,
    count(DISTINCT if(event = '$pageview', person_id, NULL)) AS visitors,
    countIf(event = 'start_learning_clicked') AS clicks
  FROM events
  WHERE ${where}
`;

const COUNTRIES = (where) => `
  SELECT properties.$geoip_country_name AS country,
         properties.$geoip_country_code AS code,
         count() AS views
  FROM events
  WHERE event = '$pageview' AND ${where}
    AND country != '' AND country IS NOT NULL
  GROUP BY country, code
  ORDER BY views DESC
  LIMIT 30
`;

/* The two totals and the country list are load-bearing: if they fail the run
   should go red and leave the last good page up. The date span and the weekly
   trend are extras, so a query error there just hides that panel. */
async function safe(query) {
  try {
    return await hogql(query);
  } catch (err) {
    console.warn(`optional query failed, continuing without it: ${err.message}`);
    return [];
  }
}

async function fetchData() {
  if (FIXTURE) return JSON.parse(readFileSync(FIXTURE, "utf8"));

  const [all, last30, countries, span, weeks] = await Promise.all([
    hogql(TOTALS(HOSTFILTER)),
    hogql(TOTALS(`${HOSTFILTER} AND ${WINDOW}`)),
    hogql(COUNTRIES(HOSTFILTER)),
    safe(`SELECT min(timestamp), max(timestamp) FROM events WHERE ${HOSTFILTER}`),
    safe(`
      SELECT toStartOfWeek(timestamp, 1) AS week, count() AS views
      FROM events
      WHERE event = '$pageview' AND ${HOSTFILTER}
      GROUP BY week ORDER BY week ASC LIMIT 26
    `),
  ]);

  const [firstSeen, lastSeen] = span[0] || [null, null];
  return {
    all: all[0] || [0, 0, 0],
    last30: last30[0] || [0, 0, 0],
    countries,
    firstSeen,
    lastSeen,
    weeks,
  };
}

const data = await fetchData();
const [views, visitors, clicks] = data.all.map(Number);
const [views30, visitors30, clicks30] = data.last30.map(Number);
const countries = data.countries || [];
const weeksRaw = data.weeks || [];

function flag(code) {
  if (!code || code.length !== 2) return "🌍";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const day = (v) => (v ? new Date(v) : null);
const fmtDate = (d) => (d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");
const now = new Date();
const first = day(data.firstSeen);
const last = day(data.lastSeen);
const daysSince = last ? Math.floor((now - last) / 86400000) : null;

/* The line that stops an empty 30-day window reading as a broken page. */
let statusText;
if (!views) {
  statusText = "No visits recorded yet. Share the link and the first ones will show up here within the hour.";
} else if (views30) {
  const when = daysSince === null ? "" : ` Last visit ${daysSince === 0 ? "today" : daysSince === 1 ? "yesterday" : `${daysSince} days ago`}.`;
  statusText = `${views30} page ${views30 === 1 ? "view" : "views"} in the last 30 days.${when}`;
} else {
  const when = last ? ` The last visit was ${fmtDate(last)}, ${daysSince} days ago.` : "";
  statusText = `Quiet right now: nobody has visited in the last 30 days.${when} The totals above are still your real all-time numbers.`;
}

const sub = (n30) => `<div class="sub30">${n30} in the last 30 days</div>`;

const maxViews = Math.max(1, ...countries.map((c) => Number(c[2])));
const countryRows = countries.length
  ? countries
      .map(
        ([name, code, v]) => `
    <div class="row"><span class="flag">${flag(code)}</span><span class="name">${name}</span><span class="bar"><i style="width:${Math.round((Number(v) / maxViews) * 100)}%"></i></span><span class="v">${v}</span></div>`,
      )
      .join("")
  : `<div class="row"><span class="flag">🌱</span><span class="name" style="width:auto">No visitors yet. Share the site and they'll appear here.</span></div>`;

/* PostHog only returns weeks that actually had events, so a gap of no traffic
   would silently vanish from the chart and a two-month drought would look like
   two busy weeks side by side. Fill every week from the first one to this one. */
function fillWeeks(rows) {
  if (!rows.length) return [];
  const monday = (d) => {
    const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7));
    return u;
  };
  const counts = new Map(rows.map(([w, v]) => [monday(new Date(w)).toISOString().slice(0, 10), Number(v)]));
  const out = [];
  for (let d = monday(new Date(rows[0][0])), end = monday(now); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    const key = d.toISOString().slice(0, 10);
    out.push([key, counts.get(key) || 0]);
  }
  const recent = out.slice(-26);
  /* A drought longer than the window would leave 26 empty bars and hide the
     history entirely, so in that case show the weeks that actually have data. */
  return recent.some(([, v]) => v > 0) ? recent : out.slice(0, 26);
}

const weeks = fillWeeks(weeksRaw);
const maxWeek = Math.max(1, ...weeks.map((w) => Number(w[1])));
const weekBars = weeks
  .map(([w, v]) => {
    const d = new Date(w);
    const label = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    const h = Math.max(3, Math.round((Number(v) / maxWeek) * 100));
    const zero = Number(v) === 0 ? " zero" : "";
    return `<div class="wk${zero}" title="Week of ${label}: ${v} page views"><span class="wv">${v}</span><span class="wb" style="height:${h}%"></span><span class="wl">${label}</span></div>`;
  })
  .join("");

const trendPanel = weeks.length
  ? `
  <div class="panel">
    <h2>Page views by week</h2>
    <p class="ph">Every week since the site went up</p>
    <div class="chart">${weekBars}</div>
  </div>`
  : "";

const stamp = now.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
const sinceLine = first ? `All-time totals cover everything since ${fmtDate(first)}.` : "";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="900" />
<title>Sawiyya · Live Analytics</title>
<style>
  :root{--teal:#0F6E6A;--teal-deep:#0b4f4c;--gold:#E6B24C;--coral:#E8654C;--sand:#F6EFE3;--paper:#FBF7EF;--ink:#1f2d2b;--muted:#6b7a77;--line:#e7ded0}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--paper);color:var(--ink);padding:32px 20px 60px;-webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto}
  .top{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .logo{width:46px;height:46px;border-radius:13px;background:var(--teal);color:#fff;display:grid;place-items:center;font-size:1.5rem;box-shadow:0 6px 0 0 var(--teal-deep)}
  h1{font-size:1.5rem;font-weight:800;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:.92rem;margin:4px 0 26px}
  .snap{display:inline-flex;align-items:center;gap:7px;background:#e7f6ef;border:1px solid #bfe6d4;border-radius:999px;padding:5px 13px;font-size:.78rem;font-weight:700;color:var(--teal);margin-bottom:26px}
  .dot{width:8px;height:8px;border-radius:50%;background:#2ec07a;box-shadow:0 0 0 0 rgba(46,192,122,.6);animation:p 1.8s ease-out infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(46,192,122,.5)}100%{box-shadow:0 0 0 8px rgba(46,192,122,0)}}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:14px}
  @media(max-width:620px){.cards{grid-template-columns:1fr}}
  .card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 10px 30px -18px rgba(15,110,106,.25)}
  .card .n{font-size:2.6rem;font-weight:800;line-height:1;color:var(--teal)}
  .card .l{margin-top:8px;font-size:.86rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  .card .sub30{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:.82rem;font-weight:600;color:var(--muted)}
  .card.coral .n{color:var(--coral)} .card.gold .n{color:#c9912f}
  .status{background:#fff;border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:14px;padding:15px 18px;font-size:.92rem;line-height:1.55;color:var(--ink);margin-top:14px}
  .panel{background:#fff;border:1px solid var(--line);border-radius:20px;padding:24px;box-shadow:0 10px 30px -18px rgba(15,110,106,.25);margin-top:14px}
  .panel h2{font-size:1.05rem;font-weight:800;margin-bottom:4px}
  .panel .ph{color:var(--muted);font-size:.85rem;margin-bottom:18px}
  .row{display:flex;align-items:center;gap:14px;margin:12px 0}
  .row .flag{font-size:1.5rem;width:30px;text-align:center}
  .row .name{width:175px;font-weight:600;font-size:.95rem}
  .bar{flex:1;height:14px;background:var(--sand);border-radius:999px;overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--teal),#1aa39c);border-radius:999px}
  .row .v{width:52px;text-align:right;font-weight:700;color:var(--teal)}
  .chart{display:flex;align-items:flex-end;gap:6px;overflow-x:auto;padding-bottom:4px}
  .wk{flex:1 0 42px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:160px}
  .wk .wv{font-size:.75rem;font-weight:700;color:var(--teal);margin-bottom:4px}
  .wk .wb{width:100%;max-width:34px;background:linear-gradient(180deg,#1aa39c,var(--teal));border-radius:7px 7px 3px 3px;min-height:3px}
  .wk.zero .wv{color:var(--muted)} .wk.zero .wb{background:var(--line)}
  .wk .wl{font-size:.68rem;color:var(--muted);margin-top:7px;white-space:nowrap}
  @media(max-width:620px){
    .row{gap:9px} .row .flag{width:22px;font-size:1.2rem}
    .row .name{width:108px;font-size:.88rem} .row .v{width:32px}
    .wk{flex:0 0 38px}
  }
  .actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
  .btn{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-weight:700;font-size:.95rem;padding:13px 20px;border-radius:14px}
  .btn-ghost{background:transparent;color:var(--teal);border:2px solid var(--line)}
  .foot{color:var(--muted);font-size:.8rem;margin-top:30px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="logo">🤟</div><h1>Sawiyya · Website Analytics</h1></div>
  <p class="sub">Who's visiting <strong>sawiyya.com</strong>, and from where.</p>
  <span class="snap"><span class="dot"></span> Live · auto-updates hourly · last refreshed ${stamp}</span>
  <div class="cards">
    <div class="card"><div class="n">${views}</div><div class="l">Page views</div>${sub(views30)}</div>
    <div class="card gold"><div class="n">${visitors}</div><div class="l">Unique visitors</div>${sub(visitors30)}</div>
    <div class="card coral"><div class="n">${clicks}</div><div class="l">“Start learning” clicks</div>${sub(clicks30)}</div>
  </div>
  <p class="status">${statusText}</p>
  ${trendPanel}
  <div class="panel">
    <h2>Visitors by country</h2>
    <p class="ph">All time</p>
    ${countryRows}
  </div>
  <div class="actions">
    <a class="btn btn-ghost" href="https://sawiyya.com" target="_blank">Visit sawiyya.com</a>
  </div>
  <p class="foot">This page updates itself automatically, so just refresh or reopen it anytime to see the latest. The big number on each card is the all-time total; the line under it is the last 30 days only. ${sinceLine}</p>
</div>
</body>
</html>`;

writeFileSync("stats.html", html);
console.log(
  `Wrote stats.html: all time ${views}/${visitors}/${clicks}, last 30d ${views30}/${visitors30}/${clicks30}, ${countries.length} countries, ${weeks.length} weeks.`,
);
