#!/usr/bin/env node
// Starts mcp-voice-simulator with a choice of brain:
//   SIM_BRAIN=bedrock (default)  Amazon Bedrock Converse API, AWS credential chain
//   SIM_BRAIN=claude             the simulator's built-in Anthropic API brain
// See README.md in this folder for the environment variables and AWS setup.

import {
  McpSessionManager,
  createClaudeBrain,
  createElevenLabsTts,
  createServer,
} from "mcp-voice-simulator";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_ID, DEFAULT_REGION, createBedrockBrain } from "./bedrock-brain.mjs";

function env(name) {
  return process.env[name]?.trim() || undefined;
}

function fail(message) {
  console.error(`odobook-voice-sim: ${message}`);
  process.exit(1);
}

const mcpUrl = env("MCP_URL");
if (!mcpUrl) fail("MCP_URL is required (the full URL of the MCP endpoint, ending in /mcp).");

const port = Number(env("SIM_PORT") ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`SIM_PORT must be a port number (got "${env("SIM_PORT")}").`);

const simUi = (env("SIM_UI") ?? "on").toLowerCase();
if (simUi !== "on" && simUi !== "off") fail(`SIM_UI must be "on" or "off" (got "${simUi}").`);
const uiEnabled = simUi === "on";

const linkTimeoutMs = Number(env("SIM_LINK_TIMEOUT_MS") ?? 300_000);
if (!Number.isInteger(linkTimeoutMs) || linkTimeoutMs <= 0) fail("SIM_LINK_TIMEOUT_MS must be a positive number of milliseconds.");

const sessionManager = new McpSessionManager({
  mcpUrl,
  bearerToken: env("MCP_BEARER_TOKEN"),
  link: { clientId: env("MCP_CLIENT_ID"), timeoutMs: linkTimeoutMs },
  ui: uiEnabled,
});

const brainName = (env("SIM_BRAIN") ?? "bedrock").toLowerCase();
let brain;
let brainLabel;
if (brainName === "bedrock") {
  const region = env("AWS_REGION") ?? env("AWS_DEFAULT_REGION") ?? DEFAULT_REGION;
  const modelId = env("BEDROCK_MODEL_ID") ?? DEFAULT_MODEL_ID;
  brain = createBedrockBrain({
    session: () => sessionManager.ensureSession(),
    modelId,
    region,
  });
  brainLabel = `bedrock (${modelId} in ${region}, AWS profile: ${env("AWS_PROFILE") ?? "default chain"})`;
} else if (brainName === "claude") {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) fail("SIM_BRAIN=claude needs ANTHROPIC_API_KEY.");
  brain = createClaudeBrain({
    apiKey,
    session: () => sessionManager.ensureSession(),
    model: env("SIM_MODEL"),
  });
  brainLabel = `claude (${env("SIM_MODEL") ?? "simulator default model"})`;
} else {
  fail(`SIM_BRAIN must be "bedrock" or "claude" (got "${brainName}").`);
}

// Voice: the browser's own by default; SIM_TTS=elevenlabs for server-side ElevenLabs.
let tts;
if ((env("SIM_TTS") ?? "browser").toLowerCase() === "elevenlabs") {
  const apiKey = env("ELEVENLABS_API_KEY");
  const voiceId = env("ELEVENLABS_VOICE_ID");
  if (!apiKey || !voiceId) fail("SIM_TTS=elevenlabs needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.");
  tts = createElevenLabsTts({ apiKey, voiceId, modelId: env("ELEVENLABS_MODEL") });
}

// Odobook's own page (public/index.html, with the instrument cluster) replaces the package's.
// The page still loads the package's tts.js and host.js, so copy those in from the installed version.
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const packagePublic = join(dirname(fileURLToPath(import.meta.resolve("mcp-voice-simulator"))), "..", "public");
for (const file of ["tts.js", "host.js"]) copyFileSync(join(packagePublic, file), join(publicDir, file));

createServer({ sessionManager, brain, port, tts, ui: uiEnabled ? {} : false, publicDir });

console.log(`odobook-voice-sim: http://127.0.0.1:${port}`);
console.log(`  MCP server: ${mcpUrl}`);
console.log(`  Brain: ${brainLabel}`);
console.log(`  Voice: ${tts?.name ?? "browser"}`);
console.log(`  Views (MCP Apps): ${uiEnabled ? "on" : "off"}`);
