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
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#14171c;--muted:#5b6472;--line:#d9dde3;--accent:#0b6bcb;--warn:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#181c22;--ink:#e8ebef;--muted:#9aa3ae;--line:#2a3039;--accent:#5aa7f0;--warn:#f08a8a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:440px;margin:40px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:4px 0 16px}
label{display:block;font-size:14px;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 16px system-ui;cursor:pointer}
a.switch{display:block;margin-top:12px;padding:10px;border:1px solid var(--line);border-radius:10px;text-align:center;color:var(--muted);text-decoration:none}
ul{padding-left:20px;color:var(--muted)}.err{color:var(--warn)}.small{font-size:13px}
a{color:var(--accent)}
</style></head><body><main>${body}</main></body></html>`,
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
    error ? 400 : 200,
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

const LANDING = `<div class="card"><h1>Odobook</h1>
<p>A voice car logbook. Say "start a work trip to Geelong" when you leave and "end trip" when you arrive. Odobook keeps the ATO 12-week logbook (or an IRS mileage log) for you.</p>
<p class="small">MCP endpoint: <code>/mcp</code> · Built to the Alexa+ add-on requirements (Streamable HTTP, OAuth 2.1 + PKCE). <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p></div>`;

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
        return page("Odobook", LANDING);
      case "/privacy":
        return page("Odobook privacy", PRIVACY);
      case "/terms":
        return page("Odobook terms", TERMS);
      default:
        return new Response("Not found", { status: 404 });
    }
  },
};
