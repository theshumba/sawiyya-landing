// Generates stats.html for sawiyya.com/stats — a live analytics page.
// Runs in GitHub Actions on a schedule. Reads PostHog via the query API.
// Needs env POSTHOG_API_KEY (a PostHog personal API key with query:read).
// If the key is absent it exits 0 without writing, so the workflow stays green
// until the secret is added.
import { writeFileSync } from "node:fs";

const KEY = process.env.POSTHOG_API_KEY;
const PROJECT = process.env.POSTHOG_PROJECT_ID || "148422";
const HOST = process.env.POSTHOG_HOST || "https://eu.posthog.com";

if (!KEY) {
  console.log("No POSTHOG_API_KEY set — skipping stats generation (workflow stays green).");
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

const SINCE = "now() - INTERVAL 30 DAY";
const HOSTFILTER = "properties.$host ILIKE '%sawiyya.com%'";

const totals = (
  await hogql(`
    SELECT
      countIf(event = '$pageview') AS views,
      count(DISTINCT if(event = '$pageview', person_id, NULL)) AS visitors,
      countIf(event = 'start_learning_clicked') AS clicks
    FROM events
    WHERE ${HOSTFILTER} AND timestamp > ${SINCE}
  `)
)[0] || [0, 0, 0];

const countries = await hogql(`
  SELECT properties.$geoip_country_name AS country,
         properties.$geoip_country_code AS code,
         count() AS views
  FROM events
  WHERE event = '$pageview' AND ${HOSTFILTER} AND timestamp > ${SINCE}
    AND country != '' AND country IS NOT NULL
  GROUP BY country, code
  ORDER BY views DESC
  LIMIT 30
`);

const [views, visitors, clicks] = totals;

function flag(code) {
  if (!code || code.length !== 2) return "🌍";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const maxViews = Math.max(1, ...countries.map((c) => Number(c[2])));
const countryRows = countries.length
  ? countries
      .map(
        ([name, code, v]) => `
    <div class="row"><span class="flag">${flag(code)}</span><span class="name">${name}</span><span class="bar"><i style="width:${Math.round((Number(v) / maxViews) * 100)}%"></i></span><span class="v">${v}</span></div>`,
      )
      .join("")
  : `<div class="row"><span class="flag">🌱</span><span class="name" style="width:auto">No visitors yet — share the site and they'll appear here.</span></div>`;

const now = new Date();
const stamp = now.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="900" />
<title>Sawiyya — Live Analytics</title>
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
  .card.coral .n{color:var(--coral)} .card.gold .n{color:#c9912f}
  .panel{background:#fff;border:1px solid var(--line);border-radius:20px;padding:24px;box-shadow:0 10px 30px -18px rgba(15,110,106,.25);margin-top:14px}
  .panel h2{font-size:1.05rem;font-weight:800;margin-bottom:4px}
  .panel .ph{color:var(--muted);font-size:.85rem;margin-bottom:18px}
  .row{display:flex;align-items:center;gap:14px;margin:12px 0}
  .row .flag{font-size:1.5rem;width:30px;text-align:center}
  .row .name{width:150px;font-weight:600;font-size:.95rem}
  .bar{flex:1;height:14px;background:var(--sand);border-radius:999px;overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--teal),#1aa39c);border-radius:999px}
  .row .v{width:60px;text-align:right;font-weight:700;color:var(--teal)}
  .actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
  .btn{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-weight:700;font-size:.95rem;padding:13px 20px;border-radius:14px}
  .btn-ghost{background:transparent;color:var(--teal);border:2px solid var(--line)}
  .foot{color:var(--muted);font-size:.8rem;margin-top:30px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="logo">🤟</div><h1>Sawiyya — Website Analytics</h1></div>
  <p class="sub">Who's visiting <strong>sawiyya.com</strong>, and from where.</p>
  <span class="snap"><span class="dot"></span> Live · auto-updates hourly · last refreshed ${stamp}</span>
  <div class="cards">
    <div class="card"><div class="n">${views}</div><div class="l">Page views</div></div>
    <div class="card gold"><div class="n">${visitors}</div><div class="l">Unique visitors</div></div>
    <div class="card coral"><div class="n">${clicks}</div><div class="l">“Start learning” clicks</div></div>
  </div>
  <div class="panel">
    <h2>Visitors by country</h2>
    <p class="ph">Last 30 days</p>
    ${countryRows}
  </div>
  <div class="actions">
    <a class="btn btn-ghost" href="https://sawiyya.com" target="_blank">Visit sawiyya.com</a>
  </div>
  <p class="foot">This page updates itself automatically — just refresh or reopen it anytime to see the latest. Numbers cover the last 30 days.</p>
</div>
</body>
</html>`;

writeFileSync("stats.html", html);
console.log(`Wrote stats.html — ${views} views, ${visitors} visitors, ${clicks} clicks, ${countries.length} countries.`);
