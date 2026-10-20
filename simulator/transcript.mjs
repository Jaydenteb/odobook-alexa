// Runs a scripted conversation through a brain against a live Odobook, printing every
// model response and tool call: a repeatable way to see how a model handles the voice flow.
// Usage: BASE=... ADMIN_TOKEN=... [SIM_BRAIN=bedrock|claude] node transcript.mjs
// Signs up a throwaway account (transcript-<time>@example.com).
import { createHash, randomBytes } from "node:crypto";
import { connectMcp, createClaudeBrain } from "mcp-voice-simulator";
import { createBedrockBrain } from "./bedrock-brain.mjs";

const BASE = (process.env.BASE ?? "https://odobook-alexa.odobook-alexa.workers.dev").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) throw new Error("set ADMIN_TOKEN");

const UTTERANCES = process.env.UTTERANCES
  ? JSON.parse(process.env.UTTERANCES)
  : [
      "Start a logbook for my Toyota HiLux, rego 1ABC234, odometer 52,310",
      "Start a work trip to Geelong",
      "End trip",
      "52,394",
      "Quote for a bathroom renovation",
      "The engine is 2.8 litres",
      "How's my logbook going?",
    ];

// --- a token for a fresh account, the way the simulator links
const redirect = "http://127.0.0.1:9/callback";
const reg = await (await fetch(`${BASE}/admin/clients`, {
  method: "POST",
  headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Transcript harness", redirectUris: ["http://127.0.0.1/callback"], public: true }),
})).json();
const verifier = randomBytes(32).toString("base64url");
const q = new URLSearchParams({
  response_type: "code", client_id: reg.clientId, redirect_uri: redirect, state: "t",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${BASE}/mcp`,
});
const post = await fetch(`${BASE}/authorize?${q}`, {
  method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ mode: "signup", name: "Transcript", email: `transcript-${Date.now()}@example.com`, password: "transcript password" }),
});
const code = new URL(post.headers.get("location")).searchParams.get("code");
const tok = await (await fetch(`${BASE}/oauth/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.clientId, code_verifier: verifier }),
})).json();
const session = await connectMcp(`${BASE}/mcp`, tok.access_token);

// --- a brain whose Bedrock client logs each response
const show = (content) =>
  (content ?? []).map((b) =>
    b.text != null ? `text: ${JSON.stringify(b.text)}`
    : b.toolUse ? `toolUse: ${b.toolUse.name} ${JSON.stringify(b.toolUse.input)}`
    : b.reasoningContent ? "reasoning"
    : Object.keys(b)[0]).join(" | ");
let brain;
if ((process.env.SIM_BRAIN ?? "bedrock") === "bedrock") {
  const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
  const real = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "ap-southeast-2" });
  const client = {
    async send(cmd) {
      const t0 = Date.now();
      const r = await real.send(cmd);
      console.log(`    [model ${Date.now() - t0} ms, stop=${r.stopReason}] ${show(r.output?.message?.content)}`);
      return r;
    },
  };
  brain = createBedrockBrain({ session: async () => session, client, modelId: process.env.BEDROCK_MODEL_ID });
} else {
  brain = createClaudeBrain({ session: async () => session, model: process.env.SIM_MODEL });
}

for (const u of UTTERANCES) {
  console.log(`\nDRIVER: ${u}`);
  const t0 = Date.now();
  const { reply, trace } = await brain.turn(u);
  for (const t of trace ?? []) console.log(`    [tool] ${t.name ?? t.tool} ${JSON.stringify(t.args ?? t.input ?? {})} -> ${t.isError ? "ERROR " : ""}${(t.text ?? "").slice(0, 160)}`);
  console.log(`ASSISTANT (${Date.now() - t0} ms): ${JSON.stringify(reply)}`);
}
process.exit(0);
