// Creates or refreshes the Odobook demo account used in the hackathon video and by judges.
// It links an account the same way scripts/e2e.mjs does (pre-registered client, PKCE, sign-in or
// sign-up), then makes sure there's a logbook with three weeks of realistic trips in it.
//
// Usage:
//   BASE=https://odobook-alexa.odobook-alexa.workers.dev ADMIN_TOKEN=... \
//   DEMO_EMAIL=demo@... DEMO_PASSWORD=... node scripts/seed-demo.mjs
// Options:
//   RESET=1        close the current logbook (cancelling any running trip) and start a fresh one
//   DEMO_NAME=...  name for a new account (default "Demo Driver")
//
// Without RESET, a logbook that already has trips is left alone and its status is printed.
// Odobook has no tool that deletes a logbook with trips, so RESET closes the old one instead.
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const EMAIL = process.env.DEMO_EMAIL?.trim().toLowerCase();
const PASSWORD = process.env.DEMO_PASSWORD;
const NAME = process.env.DEMO_NAME ?? "Demo Driver";
const RESET = process.env.RESET === "1";
const REDIRECT = "http://127.0.0.1:9999/callback";

if (!ADMIN) throw new Error("set ADMIN_TOKEN");
if (!EMAIL || !PASSWORD) throw new Error("set DEMO_EMAIL and DEMO_PASSWORD");
if (PASSWORD.length < 10) throw new Error("DEMO_PASSWORD needs at least 10 characters (Odobook's sign-up rule)");

const b64url = (buf) => buf.toString("base64url");
const fail = (msg) => {
  console.error(`ERROR  ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- 1. link an account (OAuth 2.1 + PKCE)

const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();

// A public client on loopback, like the simulator's. Each run registers one; they're harmless.
const reg = await fetch(`${BASE}/admin/clients`, {
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Odobook demo seeder", redirectUris: ["http://127.0.0.1/callback"], public: true }),
});
if (reg.status !== 201) fail(`couldn't register a client (${reg.status}): ${await reg.text()}`);
const { clientId } = await reg.json();

const verifier = b64url(randomBytes(32));
const q = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: "logbook:read logbook:write",
  state: "seed",
  code_challenge: b64url(createHash("sha256").update(verifier).digest()),
  code_challenge_method: "S256",
  resource: prm.resource,
});
const authUrl = `${as.authorization_endpoint}?${q}`;

async function submit(fields) {
  return fetch(authUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(BASE).origin },
    body: new URLSearchParams(fields),
  });
}

// Sign in; if the account doesn't exist yet, sign up.
let res = await submit({ mode: "signin", email: EMAIL, password: PASSWORD });
let created = false;
if (res.status !== 302) {
  res = await submit({ mode: "signup", name: NAME, email: EMAIL, password: PASSWORD });
  if (res.status !== 302) {
    const html = await res.text();
    if (html.includes("already has an account")) fail("that email already has an account, and DEMO_PASSWORD doesn't match it");
    fail(`sign-up failed (${res.status})`);
  }
  created = true;
}
const code = new URL(res.headers.get("location") ?? "", BASE).searchParams.get("code");
if (!code) fail("no authorization code in the redirect");

const tokRes = await fetch(as.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: prm.resource }),
});
const tok = await tokRes.json();
if (!tok.access_token) fail(`token exchange failed: ${JSON.stringify(tok)}`);
console.log(`${created ? "Created" : "Signed in to"} ${EMAIL}`);

// ---------------------------------------------------------------- 2. MCP helpers

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await r.json();
  if (body.error) fail(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const text = (r) => r.content?.[0]?.text ?? "";

await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "odobook-seed-demo", version: "1" } });

// ---------------------------------------------------------------- 3. existing logbook?

let status = await call("logbook_status");
if (!status.isError) {
  const trips = status.structuredContent?.trips ?? 0;
  if (trips > 0 && !RESET) {
    console.log(`\nA logbook with ${trips} trips is already there; leaving it. (RESET=1 starts a fresh one.)`);
    console.log(`Status: ${text(status)}`);
    await printLast();
    process.exit(0);
  }
  if (status.structuredContent?.activeTrip) {
    console.log(`Cancelling the running trip: ${text(await call("cancel_trip"))}`);
  }
  if (trips === 0) {
    const r = await call("discard_logbook");
    if (r.isError) fail(`discard_logbook: ${text(r)}`);
    console.log(`Discarded the empty logbook.`);
  } else {
    // close_logbook needs a reading at or above the last one Odobook knows.
    const list = await call("list_trips", { limit: 50 });
    let last = 0;
    for (const t of list.structuredContent?.trips ?? []) last = Math.max(last, t.startOdometer ?? 0, t.endOdometer ?? 0);
    let r = await call("close_logbook", { odometer: last });
    if (r.isError) {
      // The refusal names the last reading, e.g. "lower than the last reading of 52,872 km".
      const m = text(r).match(/last reading of ([\d,]+)/);
      if (m) r = await call("close_logbook", { odometer: Number(m[1].replace(/,/g, "")) });
    }
    if (r.isError) fail(`close_logbook: ${text(r)}`);
    console.log(`Closed the old logbook: ${text(r)}`);
  }
}

// ---------------------------------------------------------------- 4. a fresh logbook with three weeks of trips

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date());
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const startDate = addDays(today, -21);

let r = await call("start_logbook", {
  make: "Toyota",
  model: "HiLux",
  rego: "1ABC234",
  odometer: 52310,
  engine_cc: 2755,
  jurisdiction: "AU",
  start_date: startDate,
});
if (r.isError) fail(`start_logbook: ${text(r)}`);
console.log(`\n${text(r)}`);

// A Geelong plumber's first three weeks. Readings chain: each trip starts at or after the last one
// ended (gaps are short unlogged private runs). Day = days after the logbook's first day.
const TRIPS = [
  { day: 0, time: "07:10", kind: "business", from: 52310, to: 52334, destination: "Armstrong Creek", purpose: "Rough-in plumbing at a new build in Armstrong Creek" },
  { day: 1, time: "06:55", kind: "business", from: 52334, to: 52349, destination: "North Geelong", purpose: "Pick up hot water units from the plumbing supplier" },
  { day: 2, time: "07:30", kind: "business", from: 52349, to: 52525, destination: "Ballarat", purpose: "Site inspection for a cafe fit-out in Ballarat, return trip" },
  { day: 5, time: "08:40", kind: "private", from: 52531, to: 52567, destination: "Torquay" },
  { day: 7, time: "07:05", kind: "business", from: 52567, to: 52580, destination: "Belmont", purpose: "Bathroom renovation in Belmont: strip-out and rough-in" },
  { day: 8, time: "06:30", kind: "business", from: 52580, to: 52730, destination: "Docklands", purpose: "Coordination meeting with the builder at the Docklands site office, return trip" },
  { day: 10, time: "17:45", kind: "private", from: 52734, to: 52800, destination: "Werribee" },
  { day: 11, time: "13:20", kind: "business", from: 52800, to: 52828, destination: "Lara", purpose: "Emergency callout for a burst pipe in Lara" },
  { day: 14, time: "08:15", kind: "business", from: 52828, to: 52840, destination: "Highton", purpose: "Quote for a gas heater install in Highton" },
  { day: 16, time: "07:20", kind: "business", from: 52840, to: 52882, destination: "Ocean Grove", purpose: "Replace a hot water service in Ocean Grove" },
  { day: 18, time: "07:40", kind: "business", from: 52882, to: 52907, destination: "Armstrong Creek", purpose: "Fit-off and pressure test at the Armstrong Creek new build" },
];

for (const t of TRIPS) {
  const date = addDays(startDate, t.day);
  if (date > today) continue;
  const args = {
    date,
    kind: t.kind,
    destination: t.destination,
    start_odometer: t.from,
    end_odometer: t.to,
    start_time: t.time,
    ...(t.purpose ? { purpose: t.purpose } : {}),
  };
  const res = await call("log_trip", args);
  if (res.isError) fail(`log_trip ${date}: ${text(res)}`);
  console.log(`  ${date} ${t.time}  ${String(t.to - t.from).padStart(4)} km  ${t.kind.padEnd(8)}  ${t.destination}${res.structuredContent?.late ? "  (late)" : ""}`);
}

status = await call("logbook_status");
console.log(`\nStatus: ${text(status)}`);
await printLast();

// Every trip above was entered today, so Odobook correctly marks the older ones as late entries
// (more than 24 hours after the trip). In real use most would have been logged live with
// start_trip/end_trip. Nothing here edits that flag; see docs/demo-video-script.md for the options.
const warnings = status.structuredContent?.warnings ?? [];
if (warnings.length) {
  console.log("\nWarnings on the demo logbook:");
  for (const w of warnings) console.log(`  - ${w}`);
}

async function printLast() {
  const list = await call("list_trips", { limit: 50 });
  let last = 0;
  for (const t of list.structuredContent?.trips ?? []) last = Math.max(last, t.startOdometer ?? 0, t.endOdometer ?? 0);
  if (last) {
    console.log(`\nLast odometer reading: ${last.toLocaleString("en-AU")} km`);
    console.log(`For the demo trip to Torquay (24 km), say "end trip, odometer ${(last + 24).toLocaleString("en-AU")}".`);
  }
}
