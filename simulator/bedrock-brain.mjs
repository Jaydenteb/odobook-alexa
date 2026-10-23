// An Amazon Bedrock "brain" for mcp-voice-simulator.
//
// It implements the simulator's Brain interface ({ name, turn(utterance), reset() })
// with the Bedrock Runtime Converse API: the MCP server's tools become a Converse
// toolConfig, each toolUse block is run against the live MCP session, and the
// result goes back as a toolResult block until the model ends its turn with
// spoken text. Same job as the simulator's built-in Claude brain, but the model
// is called through AWS (IAM credentials, AWS billing) instead of the Anthropic API.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { callTool } from "mcp-voice-simulator";

// Same intent as the simulator's Claude brain prompt: short spoken replies, use the
// tools, preview before confirming anything destructive, report errors plainly.
export const DEFAULT_SYSTEM_PROMPT = [
  "You are a voice assistant speaking through a smart display. Replies are read aloud: one or two short sentences, plain words, no markdown, no lists, no line breaks.",
  "Use the provided tools for anything the user's request maps to. Prefer the tool whose name or description best matches what they said.",
  "When a request is missing something a tool needs (a reading, a purpose), ask one short question. Never ask for two things at once.",
  "For any tool with a confirm or dryRun parameter: never pass confirm: true or dryRun: false until the user has explicitly agreed in their latest message. Preview first, then ask.",
  "Report tool results faithfully. If a tool returns an error, nothing was done: never say it succeeded. Don't add advice or commentary the tool didn't give.",
].join(" ");

/**
 * A model reply as speech: no markdown emphasis, bullets, headings or line breaks.
 * (Voice brains read this aloud, and small models like to format.)
 */
export function toSpeech(text) {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s*\n+\s*/g, (m, i, s) => (/(?:[.!?:,;]|\b(?:or|and))$/i.test(s.slice(0, i).trimEnd()) ? " " : ". "))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Today's date for the system prompt. A real voice host always knows the date; without it the model
 * guesses, and "yesterday" became 4 June 2024 in testing. Uses this machine's time zone.
 */
export function todayLine(now = new Date()) {
  const day = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return `Today is ${day} (${iso}).`;
}

// Amazon Nova 2 Lite through the global cross-Region inference profile (the only route to Nova 2
// Lite from Sydney). Tested live 20 Oct 2026: Converse tool use works. Override with BEDROCK_MODEL_ID.
export const DEFAULT_MODEL_ID = "global.amazon.nova-2-lite-v1:0";
export const DEFAULT_REGION = "ap-southeast-2";

const TOO_MANY_STEPS = "Sorry, that took too many steps. Could you say that again?";

// Converse tool names must match ^[a-zA-Z0-9_-]{1,64}$; MCP allows more (dots, slashes).
const TOOL_NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * MCP tools -> Converse toolConfig, plus a map from the Converse name back to the
 * MCP name (they only differ when an MCP name isn't a valid Converse name).
 */
export function toConverseTools(mcpTools) {
  const nameMap = new Map();
  const tools = [];
  for (const t of mcpTools) {
    let name = TOOL_NAME_OK.test(t.name) ? t.name : t.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    if (nameMap.has(name)) {
      let i = 2;
      while (nameMap.has(`${name.slice(0, 60)}_${i}`)) i++;
      name = `${name.slice(0, 60)}_${i}`;
    }
    nameMap.set(name, t.name);
    // MCP inputSchema is JSON Schema, which is what Converse's inputSchema.json takes.
    // Drop the top-level $schema dialect marker; everything else passes through.
    const schema =
      t.inputSchema && typeof t.inputSchema === "object"
        ? { ...t.inputSchema }
        : { type: "object", properties: {} };
    delete schema.$schema;
    if (!schema.type) schema.type = "object";
    tools.push({
      toolSpec: {
        name,
        // Converse rejects an empty description.
        description: t.description || t.title || t.name,
        inputSchema: { json: schema },
      },
    });
  }
  return { toolConfig: tools.length ? { tools } : undefined, nameMap };
}

/** A Bedrock/AWS SDK error -> one short sentence the simulator can read aloud. */
export function spokenBedrockError(err) {
  const name = err?.name ?? "";
  switch (name) {
    case "AccessDeniedException":
      return "Sorry, I can't reach my Amazon Bedrock model. Access was denied, so check the model access and IAM permissions for this AWS account.";
    case "ResourceNotFoundException":
      return "Sorry, the Amazon Bedrock model I'm set up to use wasn't found in this region. Check the model ID.";
    case "ValidationException":
      return "Sorry, Amazon Bedrock rejected that request as invalid. Check the model ID and region.";
    case "ThrottlingException":
    case "ServiceQuotaExceededException":
      return "Sorry, Amazon Bedrock is rate limiting me right now. Try again in a moment.";
    case "ModelNotReadyException":
    case "ServiceUnavailableException":
    case "InternalServerException":
    case "ModelTimeoutException":
      return "Sorry, the Amazon Bedrock model isn't responding right now. Try again in a moment.";
    case "CredentialsProviderError":
    case "UnrecognizedClientException":
    case "ExpiredTokenException":
      return "Sorry, I don't have working AWS credentials. Check the AWS profile I'm running with.";
    default:
      return "Sorry, something went wrong talking to Amazon Bedrock.";
  }
}

function replyFromContent(content) {
  return toSpeech(
    (content ?? [])
      .filter((block) => typeof block.text === "string")
      .map((block) => block.text)
      .join(" "),
  );
}

/**
 * @param {object} options
 * @param {() => Promise<import("mcp-voice-simulator").McpSession>} options.session
 * @param {string} [options.modelId]   Bedrock model ID or inference profile ID/ARN.
 * @param {string} [options.region]    AWS Region for the bedrock-runtime client.
 * @param {string} [options.systemPrompt]
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxToolRounds]
 * @param {boolean} [options.speakToolResults]  When a round is one tool call that returns text, speak
 *   that text as the reply instead of asking the model to rephrase it (default true). MCP servers built
 *   for voice, like Odobook, write their tool replies to be read aloud; speaking them directly is
 *   faithful (a refused call can't be reported as done) and saves a model round trip.
 * @param {{ send(command: unknown): Promise<any> }} [options.client]  Inject a client (tests).
 * @param {(msg: string, err: unknown) => void} [options.log]
 */
export function createBedrockBrain(options) {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const region = options.region ?? DEFAULT_REGION;
  const maxToolRounds = options.maxToolRounds ?? 6;
  const maxTokens = options.maxTokens ?? 2048;
  const speakToolResults = options.speakToolResults ?? true;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const log = options.log ?? ((msg, err) => console.error(`bedrock-brain: ${msg}`, err));
  // Credentials come from the standard AWS chain (AWS_PROFILE, env vars, SSO, ...).
  const client = options.client ?? new BedrockRuntimeClient({ region });
  /** Converse messages for the whole conversation, appended to only. */
  const history = [];

  return {
    name: "bedrock",
    modelId,
    region,
    reset() {
      history.length = 0;
    },
    async turn(utterance) {
      const session = await options.session();
      const { toolConfig, nameMap } = toConverseTools(session.tools);
      const turnStart = history.length;
      const trace = [];
      history.push({ role: "user", content: [{ text: utterance }] });

      try {
        for (let round = 0; round < maxToolRounds; round++) {
          let response;
          try {
            response = await client.send(
              new ConverseCommand({
                modelId,
                system: [{ text: `${systemPrompt}

${todayLine()}` }],
                messages: history,
                ...(toolConfig ? { toolConfig } : {}),
                inferenceConfig: { maxTokens },
              }),
            );
          } catch (err) {
            // A Bedrock failure is spoken, not thrown: the simulator treats a thrown
            // error as a dead MCP session and forces the user to re-link their account.
            log(`Converse failed (${err?.name ?? "Error"}): ${err?.message ?? err}`, err);
            history.length = turnStart;
            return { reply: spokenBedrockError(err), trace };
          }

          const message = response.output?.message ?? { role: "assistant", content: [] };
          // Keep every block (including reasoningContent) so the next call replays it unchanged.
          history.push({ role: "assistant", content: message.content ?? [] });

          const toolUses = (message.content ?? []).filter((block) => block.toolUse).map((b) => b.toolUse);
          if (toolUses.length === 0) {
            const reply = replyFromContent(message.content);
            if (reply) return { reply, trace };
            if (response.stopReason === "max_tokens") {
              return { reply: "Sorry, my answer ran too long. Could you ask that a simpler way?", trace };
            }
            if (response.stopReason === "guardrail_intervened" || response.stopReason === "content_filtered") {
              return { reply: "Sorry, I can't help with that one.", trace };
            }
            return { reply: "Sorry, I didn't catch that. Could you say it again?", trace };
          }

          const results = [];
          let lastText = "";
          for (const use of toolUses) {
            const mcpName = nameMap.get(use.name) ?? use.name;
            const input = use.input && typeof use.input === "object" ? use.input : {};
            const callResult = await callTool(session, mcpName, input);
            trace.push(callResult);
            lastText = callResult.text ?? "";
            results.push({
              toolResult: {
                toolUseId: use.toolUseId,
                // Converse rejects an empty text block.
                content: [{ text: callResult.text || (callResult.isError ? "Tool error." : "(no text output)") }],
                status: callResult.isError ? "error" : "success",
              },
            });
          }
          history.push({ role: "user", content: results });
          if (speakToolResults && toolUses.length === 1 && lastText.trim()) {
            // Speak the tool's own reply. Record it as the assistant's turn so the history stays
            // valid for Converse (a toolResult must be followed by an assistant message).
            const reply = toSpeech(lastText);
            history.push({ role: "assistant", content: [{ text: reply }] });
            return { reply, trace };
          }
        }
      } catch (err) {
        // An MCP transport failure: drop this turn so the history stays valid
        // (no dangling toolUse), then let the simulator relink as it normally does.
        history.length = turnStart;
        throw err;
      }
      // Ran out of rounds with a toolResult as the last message; drop the turn so the
      // next one doesn't start with two user messages in a row (Converse rejects that).
      history.length = turnStart;
      return { reply: TOO_MANY_STEPS, trace };
    },
  };
}
