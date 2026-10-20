// Account linking in a real (headless) browser, the way a person does it from the simulator or the
// Alexa app: open /authorize, switch to sign-up, fill the form, submit, land on the loopback callback
// with a code; then link again with the same account through the sign-in form.
// Catches what the Node e2e can't: form submission, Origin/Referrer headers, CSP, redirects.
// Usage: BASE=... ADMIN_TOKEN=... node scripts/browser-e2e.mjs
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) throw new Error("set ADMIN_TOKEN");

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
};

// A loopback callback, like the simulator's.
const codes = [];
const cb = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  codes.push({ code: u.searchParams.get("code"), state: u.searchParams.get("state"), error: u.searchParams.get("error") });
  res.end("linked");
});
await new Promise((r) => cb.listen(0, "127.0.0.1", r));
const redirect = `http://127.0.0.1:${cb.address().port}/callback`;

const reg = await fetch(`${BASE}/admin/clients`, {
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Browser test", redirectUris: ["http://127.0.0.1/callback"], public: true }),
});
const { clientId } = await reg.json();

function authorizeUrl(state) {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  return { url: `${BASE}/authorize?${q}`, verifier };
}

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(String(e)));

const email = `browser-${Date.now()}@example.com`;
const password = "a long test password";

// 1. Sign up through the switch link.
const a = authorizeUrl("signup-state");
await page.goto(a.url);
check(await page.getByRole("button", { name: "Sign in and allow" }).isVisible(), "authorize page shows the sign-in form");
await page.getByRole("link", { name: "New here? Create an account" }).click();
check(await page.getByRole("button", { name: "Create account and allow" }).isVisible(), "switch link opens the sign-up form");
await page.fill("#name", "Browser Tester");
await page.fill("#email", email);
await page.fill("#password", password);
await Promise.all([page.waitForURL(/127\.0\.0\.1:\d+\/callback/), page.getByRole("button", { name: "Create account and allow" }).click()]);
check(codes.at(-1)?.code && codes.at(-1)?.state === "signup-state", "sign-up lands on the callback with a code and state");

// 2. Sign in again with the same account.
const b = authorizeUrl("signin-state");
await page.goto(b.url);
await page.fill("#email", email);
await page.fill("#password", password);
await Promise.all([page.waitForURL(/127\.0\.0\.1:\d+\/callback/), page.getByRole("button", { name: "Sign in and allow" }).click()]);
check(codes.at(-1)?.code && codes.at(-1)?.state === "signin-state", "sign-in lands on the callback with a code and state");

// 3. A wrong password shows an error on the page instead of redirecting.
const c = authorizeUrl("bad-state");
await page.goto(c.url);
await page.fill("#email", email);
await page.fill("#password", "wrong password");
await page.getByRole("button", { name: "Sign in and allow" }).click();
check(await page.getByText("That email and password don't match.").isVisible(), "a wrong password shows a friendly error");

// 4. The code from step 2 exchanges for a token that works on /mcp.
const tok = await (await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: codes[1].code, redirect_uri: redirect, client_id: clientId, code_verifier: b.verifier }),
})).json();
const mcp = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check(mcp.status === 200, "the browser-linked token works on /mcp");

check(problems.length === 0, "no console errors or CSP violations", problems.join(" | "));
await browser.close();
cb.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
