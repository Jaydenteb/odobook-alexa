// End-to-end check of the Alexa+ path against a running Odobook (local or deployed):
// discovery -> pre-registered client -> sign-up -> PKCE authorization code -> token -> MCP tools.
// Usage: BASE=http://localhost:8787 ADMIN_TOKEN=... node scripts/e2e.mjs
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const REDIRECT = "http://127.0.0.1:9999/callback";
if (!ADMIN) throw new Error("set ADMIN_TOKEN");

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
};
const b64url = (buf) => buf.toString("base64url");

// 1. Discovery, as Alexa+ does it: bare 401, then the well-known documents.
const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(unauth.status === 401 && !unauth.headers.has("www-authenticate"), "unauthenticated /mcp gives a bare 401");
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
check(prm.resource === `${BASE}/mcp`, "protected resource metadata names the canonical resource");
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
check(as.code_challenge_methods_supported?.includes("S256"), "authorization server advertises S256");
check(!as.registration_endpoint, "no dynamic client registration (as Alexa+ expects)");

// 2. A pre-registered confidential client, like an Alexa+ add-on's.
const reg = await fetch(`${BASE}/admin/clients`, {
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "E2E test (Alexa+ stand-in)", redirectUris: [REDIRECT] }),
});
const client = await reg.json();
check(reg.status === 201 && client.clientId && client.clientSecret, "admin registers a confidential client");

// 3. Authorization code + PKCE, with the resource parameter.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const q = new URLSearchParams({
  response_type: "code",
  client_id: client.clientId,
  redirect_uri: REDIRECT,
  scope: "logbook:read logbook:write",
  state: "xyz",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: prm.resource,
});
const authUrl = `${as.authorization_endpoint}?${q}`;
const authHtml = await (await fetch(authUrl)).text();
check(authHtml.includes("Sign in and allow"), "authorize page renders");
// Following the "Create an account" switch must keep the original authorization query.
const switchHref = authHtml.match(/class="switch" href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
const switched = switchHref ? await (await fetch(new URL(switchHref, BASE))).text() : "";
check(switched.includes("Create account and allow"), "the sign-up switch keeps the authorization request");
const email = `e2e-${Date.now()}@example.com`;
const post = await fetch(authUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ mode: "signup", name: "Test Driver", email, password: "correct horse battery" }),
});
const loc = post.headers.get("location") ?? "";
const code = new URL(loc, BASE).searchParams.get("code");
check(post.status === 302 && loc.startsWith(REDIRECT) && code, "sign-up redirects back with a code");
check(new URL(loc).searchParams.get("state") === "xyz", "state is returned");

const tokenRes = await fetch(as.token_endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
  },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, resource: prm.resource }),
});
const tok = await tokenRes.json();
check(tokenRes.status === 200 && tok.access_token, "token exchange with PKCE verifier and resource");

// 4. MCP over Streamable HTTP, timing each round trip against the 500 ms budget.
let id = 0;
const times = [];
async function rpc(method, params) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const ms = performance.now() - t0;
  times.push([method === "tools/call" ? params.name : method, ms]);
  const body = await r.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const say = (r) => r.content?.[0]?.text ?? "";

const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
check(init.protocolVersion === "2025-11-25", "negotiates MCP 2025-11-25", init.protocolVersion);
const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
check(tools.length === 9, "lists 9 tools", tools.join(", "));

const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
let r = await call("logbook_status");
check(r.isError === true, "status without a logbook asks to start one");
r = await call("start_logbook", { make: "Toyota", model: "HiLux", rego: "1abc234", odometer: 52310, engine_cc: 2800 });
check(!r.isError, "start_logbook", say(r));
r = await call("start_trip", { kind: "business", destination: "Geelong" });
check(!r.isError, "start_trip", say(r));
r = await call("start_trip", {});
check(r.isError === true, "a second trip is refused while one runs");
r = await call("end_trip", { odometer: 52394, purpose: "business" });
check(r.isError === true, 'a vague "business" purpose is refused', say(r));
r = await call("end_trip", { odometer: 52394, purpose: "Quote for a bathroom renovation" });
check(!r.isError && /84 km/.test(say(r)), "end_trip logs 84 km", say(r));
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date());
r = await call("log_trip", { date: today, kind: "private", distance: 12, destination: "Supermarket" });
check(!r.isError, "log_trip (private, no odometer)", say(r));
r = await call("logbook_status");
check(!r.isError && r.structuredContent?.trips === 2, "logbook_status", say(r));
r = await call("list_trips", { limit: 5 });
check(!r.isError && r.structuredContent?.trips?.length === 2, "list_trips", say(r));
r = await call("export_logbook");
check(r.content?.[1]?.resource?.mimeType === "text/csv", "export_logbook returns CSV");

// 5. Replaying the authorization code is refused, and (OAuth 2.1) revokes what it issued.
const replay = await fetch(as.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, resource: prm.resource }),
});
check(replay.status >= 400, "a replayed authorization code is refused");
const after = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
});
check(after.status === 401, "and the token issued from it stops working");

// 6. The simulator's flow: a public client (no secret), a different loopback port each time, and
// no `resource` on the token request.
const pubReg = await fetch(`${BASE}/admin/clients`, {
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Voice simulator", redirectUris: ["http://127.0.0.1/callback"], public: true }),
});
const pub = await pubReg.json();
check(pubReg.status === 201 && pub.clientId && !pub.clientSecret, "admin registers a public client");
const v2 = b64url(randomBytes(32));
const redirect2 = `http://127.0.0.1:${40000 + Math.floor(Math.random() * 20000)}/callback`;
const q2 = new URLSearchParams({
  response_type: "code", client_id: pub.clientId, redirect_uri: redirect2, state: "s2",
  code_challenge: b64url(createHash("sha256").update(v2).digest()), code_challenge_method: "S256", resource: prm.resource,
});
const post2 = await fetch(`${as.authorization_endpoint}?${q2}`, {
  method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ mode: "signin", email, password: "correct horse battery" }),
});
const code2 = new URL(post2.headers.get("location") ?? "http://x/", BASE).searchParams.get("code");
check(post2.status === 302 && code2, "sign-in with a random loopback port is accepted");
const tok2 = await (await fetch(as.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: code2, redirect_uri: redirect2, client_id: pub.clientId, code_verifier: v2 }),
})).json();
const list2 = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tok2.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list" }),
});
check(list2.status === 200, "public-client token (no resource on token request) works on /mcp");
const badPort = await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...Object.fromEntries(q2), redirect_uri: "http://evil.example/callback" })}`);
check(badPort.status === 400, "a non-registered redirect URI is refused");

console.log("\nRound trips (Alexa+ budget: 500 ms):");
for (const [name, ms] of times) console.log(`  ${ms.toFixed(0).padStart(5)} ms  ${name}`);
const worst = Math.max(...times.map(([, ms]) => ms));
check(worst < 500, "every round trip under 500 ms", `worst ${worst.toFixed(0)} ms`);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
