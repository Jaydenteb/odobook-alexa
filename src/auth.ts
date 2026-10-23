/**
 * The authorization server's own pages: sign-in / sign-up and consent at /authorize, plus the
 * landing, privacy and terms pages that an Alexa+ add-on listing links to, and an admin route that
 * registers OAuth clients ahead of time (Alexa+ doesn't support Dynamic Client Registration).
 *
 * The protocol endpoints (token, metadata, PKCE checks, the resource parameter) belong to
 * @cloudflare/workers-oauth-provider. This file only decides who the user is.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_URL: string;
  ADMIN_TOKEN?: string;
}

const SCOPES = ["logbook:read", "logbook:write"];
const PBKDF2_ITERATIONS = 100_000; // the Workers runtime's maximum

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  // Not no-referrer: with that, browsers send "Origin: null" on the page's own form posts, which
  // the same-origin check below would refuse.
  "Referrer-Policy": "same-origin",
  // No form-action: browsers apply it to the redirect after a form post too, which would block the
  // hand-back to the linking app (a loopback port, or Amazon's account-linking URL).
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// One look across Odobook's pages and the voice app (simulator/public/index.html): a dark,
// instrument-cluster style. No scripts or external fonts, so the CSP stays default-src 'none'.
const LOGO = `<svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true"><defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#34d399"/></linearGradient></defs><rect width="34" height="34" rx="9" fill="#10151d" stroke="#212a36"/><path d="M7 22a10 10 0 0 1 20 0" fill="none" stroke="url(#lg)" stroke-width="3" stroke-linecap="round"/><path d="M17 22l6-7" stroke="#ffb547" stroke-width="2.5" stroke-linecap="round"/><circle cx="17" cy="22" r="2.2" fill="#eef2f7"/></svg>`;

const BASE_CSS = `:root{color-scheme:dark;--bg:#07090d;--bg2:#0b0f15;--card:#10151d;--card2:#141a24;--ink:#eef2f7;--muted:#8b95a5;--faint:#5b6574;--line:#212a36;--accent:#38bdf8;--on-accent:#03202e;--amber:#ffb547;--ok:#34d399;--warn:#ff6b6b}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:radial-gradient(1100px 560px at 75% -10%,rgba(56,189,248,.11),transparent 60%),radial-gradient(800px 480px at -10% 110%,rgba(255,181,71,.07),transparent 60%),var(--bg)}
main{max-width:440px;margin:0 auto;padding:clamp(24px,8vh,72px) 16px 40px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 18px;color:var(--ink);text-decoration:none;font-weight:700;font-size:18px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:18px;padding:24px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:4px 0 16px}
label{display:block;font-size:14px;margin:12px 0 4px;color:var(--muted)}
input{width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg2);color:inherit;font:inherit;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(56,189,248,.18)}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:999px;background:var(--accent);color:var(--on-accent);font:650 16px system-ui,sans-serif;cursor:pointer;box-shadow:0 0 28px rgba(56,189,248,.25)}
a.switch{display:block;margin-top:12px;padding:10px;border:1px solid var(--line);border-radius:999px;text-align:center;color:var(--muted);text-decoration:none}
a.switch:hover{border-color:var(--accent);color:var(--ink)}
ul{padding-left:20px;color:var(--muted)}.err{color:var(--warn)}.small{font-size:13px}
a{color:var(--accent)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}`;

const LANDING_CSS = `main.wide{max-width:1180px;padding:clamp(20px,4vh,40px) 24px 32px}
.top{display:flex;align-items:center;gap:16px;margin-bottom:clamp(24px,6vh,64px)}.top .brand{margin:0}.top nav{margin-left:auto;display:flex;gap:18px;font-size:14px}.top nav a{color:var(--muted);text-decoration:none}.top nav a:hover{color:var(--ink)}
.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:clamp(24px,4vw,56px);align-items:center}
@media (max-width:900px){.hero{grid-template-columns:1fr}}
.kicker{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 14px;font-weight:650}
.hero h1{font-size:clamp(48px,7vw,84px);line-height:.95;letter-spacing:-.03em;margin:0;background:linear-gradient(180deg,#fff,#b9c4d2);-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{font-size:clamp(22px,2.8vw,32px);color:var(--ink);margin:14px 0 14px;font-weight:650;letter-spacing:-.01em}
.lede{font-size:clamp(16px,1.5vw,19px);max-width:560px;margin:0 0 28px}
.cta{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:8px;padding:13px 22px;border-radius:999px;font-weight:650;text-decoration:none;border:1px solid var(--line);color:var(--ink);background:var(--card)}
.btn:hover{border-color:var(--accent)}
.btn.go{background:var(--accent);color:var(--on-accent);border-color:var(--accent);box-shadow:0 0 0 1px rgba(56,189,248,.3),0 0 36px rgba(56,189,248,.35);animation:beckon 2.4s ease-in-out infinite}
@keyframes beckon{50%{box-shadow:0 0 0 1px rgba(56,189,248,.55),0 0 52px rgba(56,189,248,.55)}}
.note{font-size:13px;color:var(--faint);margin:12px 0 0}
.dash{padding:0;overflow:hidden;animation:rise .8s cubic-bezier(.2,.8,.2,1) both}
.dash .row{display:grid;grid-template-columns:1fr 1.25fr}.dash .row>div{padding:18px 20px}.dash .row>div+div{border-left:1px solid var(--line)}
@media (max-width:520px){.dash .row{grid-template-columns:1fr}.dash .row>div+div{border-left:0;border-top:1px solid var(--line)}}
.h2{font-size:11px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.gauge{width:100%;max-width:210px;display:block;margin:0 auto}
.gauge .fill{stroke-dasharray:100;stroke-dashoffset:100;animation:sweep 1.8s .3s cubic-bezier(.2,.8,.2,1) forwards;filter:drop-shadow(0 0 6px rgba(56,189,248,.55))}
@keyframes sweep{to{stroke-dashoffset:19}}
.gauge .needle{transform-origin:100px 100px;transform:rotate(-90deg);animation:needle 1.8s .3s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes needle{to{transform:rotate(55.8deg)}}
.pct{text-align:center;font-size:30px;font-weight:700;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums}
.pct small{display:block;font-size:12px;color:var(--muted);font-weight:500;letter-spacing:0}
.odo{display:inline-flex;gap:3px;padding:7px 9px;background:#020305;border:1px solid #2b2418;border-radius:10px;box-shadow:inset 0 2px 12px rgba(0,0,0,.8),0 0 24px rgba(255,181,71,.08)}
.odo .d{position:relative;width:.72em;height:1.2em;overflow:hidden;font:700 34px/1.2 ui-monospace,"Cascadia Mono",Consolas,monospace;color:var(--amber);text-shadow:0 0 12px rgba(255,181,71,.55);background:linear-gradient(#0d0a05,#17120a 50%,#0d0a05);border-radius:4px}
.odo .col{position:absolute;left:0;right:0;top:0;text-align:center;animation:roll 2s cubic-bezier(.2,.8,.2,1) both}
.odo .col span{display:block;height:1.2em}
.odo .sep{align-self:flex-end;color:var(--amber);font:700 26px/1 ui-monospace,monospace;opacity:.7;margin:0 1px 5px}
@keyframes roll{from{transform:translateY(0)}to{transform:translateY(var(--y))}}
.unit{color:var(--muted);font-size:13px;margin-left:6px}
.trip{display:flex;align-items:center;gap:10px;margin-top:14px;padding:10px 12px;border-radius:12px;background:var(--bg2);border:1px solid rgba(52,211,153,.45)}
.lamp{flex:none;width:11px;height:11px;border-radius:50%;background:var(--ok);box-shadow:0 0 14px var(--ok);animation:breathe 1.6s ease-in-out infinite}
@keyframes breathe{50%{opacity:.45}}
.trip b{display:block;font-size:15px}.trip span{color:var(--muted);font-size:13px}
.weeks{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;margin-top:14px}
.weeks i{height:8px;border-radius:3px;background:var(--bg2);border:1px solid var(--line)}
.weeks i.on{background:linear-gradient(90deg,rgba(56,189,248,.65),var(--accent));border-color:transparent;animation:pop .4s both}
.chat{display:flex;flex-direction:column;gap:8px;padding:16px 20px 20px;border-top:1px solid var(--line)}
.say,.reply{margin:0;max-width:88%;padding:9px 13px;border-radius:14px;font-size:15px;line-height:1.4;color:var(--ink);animation:rise .5s cubic-bezier(.2,.8,.2,1) both}
.say{align-self:flex-end;background:var(--accent);color:var(--on-accent);border-bottom-right-radius:4px;font-weight:500}
.reply{align-self:flex-start;background:var(--card2);border:1px solid var(--line);border-bottom-left-radius:4px}
.reply.no{border-color:rgba(255,107,107,.6)}
.chat>:nth-child(1){animation-delay:1.1s}.chat>:nth-child(2){animation-delay:1.7s}.chat>:nth-child(3){animation-delay:2.5s}.chat>:nth-child(4){animation-delay:3.1s}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes pop{from{opacity:0;transform:scaleY(.2)}}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:clamp(28px,6vh,56px) 0 24px;padding:0;list-style:none}
.facts li{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:16px;padding:16px 18px;color:var(--muted);font-size:14px}
.facts b{display:block;color:var(--ink);font-size:16px;margin-bottom:4px}
.facts i{font-style:normal;color:var(--accent);margin-right:6px}
.foot{font-size:13px;color:var(--faint);border-top:1px solid var(--line);padding-top:14px;margin:0}`;

function page(title: string, body: string, status = 200, wide = false): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${BASE_CSS}${wide ? LANDING_CSS : ""}</style></head><body><main${wide ? ' class="wide"' : ""}>${wide ? "" : `<a class="brand" href="/">${LOGO}Odobook</a>`}${body}</main></body></html>`,
    { status, headers: HTML_HEADERS },
  );
}

// ---------------------------------------------------------------- passwords

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function hashPassword(password: string, saltB64?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: b64(bits), salt: b64(salt) };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  pw_hash: string;
  pw_salt: string;
}

async function signIn(env: Env, email: string, password: string): Promise<UserRow | null> {
  const user = await env.DB.prepare("SELECT id, email, name, pw_hash, pw_salt FROM users WHERE email = ?").bind(email).first<UserRow>();
  // Hash even when there's no such user, so the response time doesn't say whether the email exists.
  const { hash } = await hashPassword(password, user?.pw_salt ?? "AAAAAAAAAAAAAAAAAAAAAA==");
  return user && timingSafeEqual(hash, user.pw_hash) ? user : null;
}

async function signUp(env: Env, name: string, email: string, password: string): Promise<UserRow | "taken"> {
  const { hash, salt } = await hashPassword(password);
  const user = { id: crypto.randomUUID(), email, name, pw_hash: hash, pw_salt: salt };
  try {
    await env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, email, name, hash, salt, new Date().toISOString())
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return "taken";
    throw e;
  }
  return user;
}

// ---------------------------------------------------------------- /authorize

function authorizeForm(clientName: string, action: string, mode: "signin" | "signup", error?: string): Response {
  const other = mode === "signin" ? "signup" : "signin";
  return page(
    "Link Odobook",
    `<div class="card">
<h1>Link Odobook</h1>
<p><b>${esc(clientName)}</b> wants to use your Odobook car logbook.</p>
<ul class="small"><li>Start and end trips, and log past trips</li><li>Read your logbook totals and business-use percentage</li></ul>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${esc(action)}">
<input type="hidden" name="mode" value="${mode}">
${mode === "signup" ? `<label for="name">Your name</label><input id="name" name="name" autocomplete="name" required maxlength="80">` : ""}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="200">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required minlength="${mode === "signup" ? 10 : 1}" maxlength="200">
<button type="submit">${mode === "signin" ? "Sign in and allow" : "Create account and allow"}</button>
</form>
<a class="switch" href="${esc(`${action}&_mode=${other}`)}">${mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}</a>
<p class="small">Odobook keeps records. It isn't tax advice. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
</div>`,
  );
}

/** The original authorization query, with our own _mode switch removed. */
function authorizeAction(url: URL): string {
  const q = new URLSearchParams(url.search);
  q.delete("_mode");
  return `/authorize?${q.toString()}`;
}

async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
  let authReq: AuthRequest;
  try {
    // parseAuthRequest only reads the query string, so the form posts back to the same URL.
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(url.origin + authorizeAction(url)));
  } catch (e) {
    return page("Can't link", `<div class="card"><h1>That link didn't work</h1><p>${esc(e instanceof Error ? e.message : "Invalid request")}</p></div>`, 400);
  }
  // OAuth 2.1 (and Alexa+) require PKCE; the library accepts requests without it, so insist here.
  if (!authReq.codeChallenge || authReq.codeChallengeMethod !== "S256") {
    return page("Can't link", `<div class="card"><h1>That link didn't work</h1><p>This app must use PKCE (S256) to link.</p></div>`, 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  if (!client) return page("Can't link", `<div class="card"><h1>Unknown app</h1><p>This app isn't registered with Odobook.</p></div>`, 400);
  const clientName = client.clientName ?? "An app";
  const action = authorizeAction(url);

  if (request.method === "GET") {
    return authorizeForm(clientName, action, url.searchParams.get("_mode") === "signup" ? "signup" : "signin");
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Same-origin form posts only.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  const mode = form.get("mode") === "signup" ? "signup" : "signin";
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password || email.length > 200 || password.length > 200) {
    return authorizeForm(clientName, action, mode, "Enter your email and password.");
  }

  let user: UserRow | null;
  if (mode === "signup") {
    const name = String(form.get("name") ?? "").trim().slice(0, 80);
    if (!name) return authorizeForm(clientName, action, mode, "Enter your name.");
    if (password.length < 10) return authorizeForm(clientName, action, mode, "Use at least 10 characters for your password.");
    const created = await signUp(env, name, email, password);
    if (created === "taken") return authorizeForm(clientName, action, "signin", "That email already has an account. Sign in instead.");
    user = created;
  } else {
    user = await signIn(env, email, password);
    if (!user) return authorizeForm(clientName, action, mode, "That email and password don't match.");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: user.id,
    metadata: { clientName },
    scope: authReq.scope.filter((s) => SCOPES.includes(s)).length ? authReq.scope.filter((s) => SCOPES.includes(s)) : SCOPES,
    props: { userId: user.id, name: user.name },
  });
  return Response.redirect(redirectTo, 302);
}

// ---------------------------------------------------------------- admin: pre-registered clients

async function handleAdminClients(request: Request, env: Env): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!env.ADMIN_TOKEN) return json(404, { error: "not found" });
  const given = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(given, `Bearer ${env.ADMIN_TOKEN}`)) return json(401, { error: "unauthorised" });
  if (request.method !== "POST") return json(405, { error: "method not allowed" });
  const body = (await request.json().catch(() => null)) as { name?: string; redirectUris?: string[]; public?: boolean } | null;
  if (!body?.name || !Array.isArray(body.redirectUris) || body.redirectUris.length === 0) {
    return json(400, { error: "send { name, redirectUris: [...], public?: boolean }" });
  }
  const client = await env.OAUTH_PROVIDER.createClient({
    clientName: body.name,
    redirectUris: body.redirectUris,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: body.public ? "none" : "client_secret_basic",
  });
  return json(201, { clientId: client.clientId, clientSecret: client.clientSecret ?? null, redirectUris: client.redirectUris });
}

// ---------------------------------------------------------------- static pages

/** Odometer digits that roll a full turn before settling, so a 0 still moves. */
const odometer = (digits: string) =>
  [...digits]
    .map(
      (c, i) =>
        (i === digits.length - 3 ? '<span class="sep">,</span>' : "") +
        `<span class="d"><span class="col" style="--y:-${(10 + Number(c)) * 1.2}em;animation-duration:${1.3 + i * 0.22}s">` +
        "01234567890123456789".split("").map((d) => `<span>${d}</span>`).join("") +
        "</span></span>",
    )
    .join("");

const LANDING = `<header class="top"><a class="brand" href="/">${LOGO}Odobook</a>
<nav><a href="https://github.com/Jaydenteb/odobook-alexa">GitHub</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header>
<section class="hero">
<div>
<p class="kicker">Alexa+ add-on · MCP server</p>
<h1>Odobook</h1>
<p class="tag">A car logbook you talk to.</p>
<p class="lede">Say the trip when you leave and when you arrive. Odobook keeps the ATO 12-week logbook (or an IRS mileage log): every trip, the odometer readings and a real purpose, without typing while you drive.</p>
<div class="cta"><a class="btn go" href="http://127.0.0.1:8790/">Open the voice app →</a><a class="btn" href="https://github.com/Jaydenteb/odobook-alexa#demo-with-the-voice-simulator">Set it up</a></div>
<p class="note">The voice app runs on your computer and links to this server like Alexa+ would. Setup takes a minute; see the README.</p>
</div>
<div class="card dash" aria-label="Example: Odobook's dashboard during a trip">
<div class="row">
<div><p class="h2">Business use</p>
<svg class="gauge" viewBox="0 0 200 110" aria-hidden="true"><defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset=".7" stop-color="#38bdf8"/><stop offset="1" stop-color="#34d399"/></linearGradient></defs>
<path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#212a36" stroke-width="12" stroke-linecap="round"/>
<path class="fill" d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#gg)" stroke-width="12" stroke-linecap="round" pathLength="100"/>
<g class="needle"><path d="M100 100 L100 42" stroke="#ffb547" stroke-width="3" stroke-linecap="round"/><circle cx="100" cy="100" r="7" fill="#eef2f7"/></g></svg>
<div class="pct">81%<small>485 of 597 km for work</small></div></div>
<div><p class="h2">Odometer</p>
<div><span class="odo" aria-label="Odometer 52,907 km">${odometer("052907")}</span><span class="unit">km</span></div>
<div class="trip"><i class="lamp"></i><div><b>Trip running to Torquay</b><span>Work · 9:12 am · from 52,907 km</span></div></div>
<div class="weeks" aria-label="Day 22 of 84">${Array.from({ length: 12 }, (_, i) => `<i${i < 4 ? ` class="on" style="animation-delay:${0.6 + i * 0.12}s"` : ""}></i>`).join("")}</div>
<p class="small" style="margin:6px 0 0">Day 22 of 84 · 11 trips</p></div>
</div>
<div class="chat">
<p class="say">Start a work trip to Torquay.</p>
<p class="reply">Work trip to Torquay started at 9:12 am, from 52,907 km. Drive safely.</p>
<p class="say">End trip, odometer 52,931. It was for business.</p>
<p class="reply no">What was the trip for? The tax office needs a specific purpose, like "site visit at the Werribee depot", not just "business".</p>
</div>
</div>
</section>
<ul class="facts">
<li><b><i>●</i>Asks for a real purpose</b>"Business" isn't one, so it asks, one question at a time while you drive.</li>
<li><b><i>●</i>Flags late entries</b>Trips added more than a day later are marked, as the ATO expects.</li>
<li><b><i>●</i>Ready for your accountant</b>Business-use percentage and a CSV export. Never a dollar estimate.</li>
</ul>
<p class="foot">MCP endpoint <code>/mcp</code> · Streamable HTTP · OAuth 2.1 + PKCE · built to the Alexa+ add-on requirements · by Jayden Tebble (TebTally)</p>`;

const PRIVACY = `<div class="card"><h1>Privacy</h1>
<p>Odobook stores your name, email, a salted password hash, your vehicle details and the trips you log. It uses them only to keep your logbook and answer your requests.</p>
<p>Trip data is stored in Cloudflare D1. It isn't sold or shared. The voice assistant you link (such as Alexa+) receives the answers to your requests.</p>
<p>This is a hackathon prototype. Don't rely on it as your only tax record yet.</p></div>`;

const TERMS = `<div class="card"><h1>Terms</h1>
<p>Odobook helps you keep records. It isn't tax advice and doesn't decide what you can claim. Check ato.gov.au or irs.gov, or ask a registered tax agent.</p>
<p>Provided as is, without warranty, under the MIT licence.</p></div>`;

/** Everything that isn't the protected /mcp route or an OAuth protocol endpoint. */
export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/authorize":
        return handleAuthorize(request, env, url);
      case "/admin/clients":
        return handleAdminClients(request, env);
      case "/":
        return page("Odobook", LANDING, 200, true);
      case "/privacy":
        return page("Odobook privacy", PRIVACY);
      case "/terms":
        return page("Odobook terms", TERMS);
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
