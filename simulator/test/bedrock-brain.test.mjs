import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MODEL_ID,
  DEFAULT_SYSTEM_PROMPT,
  createBedrockBrain,
  spokenBedrockError,
  toConverseTools,
} from "../bedrock-brain.mjs";

// --- fakes ------------------------------------------------------------------

/** A stand-in BedrockRuntimeClient: records each ConverseCommand input, replays scripted responses. */
function fakeBedrock(script) {
  const calls = [];
  return {
    calls,
    async send(command) {
      // Deep-copy so later history mutation doesn't rewrite what we recorded.
      calls.push(structuredClone(command.input));
      const next = script.shift();
      if (!next) throw new Error("fake Bedrock: no scripted response left");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function awsError(name, message = name) {
  const err = new Error(message);
  err.name = name;
  err.$metadata = { httpStatusCode: 403 };
  return err;
}

/** A stand-in McpSession: the real callTool() from mcp-voice-simulator runs against it. */
function fakeSession(tools, handler) {
  const toolCalls = [];
  return {
    toolCalls,
    ui: false,
    tools,
    client: {
      async callTool({ name, arguments: args }) {
        toolCalls.push({ name, args });
        return handler(name, args);
      },
    },
  };
}

const LOG_TRIP = {
  name: "log_trip",
  description: "Log a business trip in the car logbook.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { km: { type: "number" }, purpose: { type: "string" } },
    required: ["km"],
    additionalProperties: false,
  },
};

const text = (t) => ({ content: [{ type: "text", text: t }] });
const endTurn = (t) => ({ output: { message: { role: "assistant", content: [{ text: t }] } }, stopReason: "end_turn" });
const toolUse = (id, name, input, preamble) => ({
  output: {
    message: {
      role: "assistant",
      content: [...(preamble ? [{ text: preamble }] : []), { toolUse: { toolUseId: id, name, input } }],
    },
  },
  stopReason: "tool_use",
});
const silentLog = () => {};

// --- tool schema conversion ----------------------------------------------------

describe("toConverseTools", () => {
  it("maps MCP tools to Converse toolSpecs with the JSON schema under inputSchema.json", () => {
    const { toolConfig, nameMap } = toConverseTools([LOG_TRIP]);
    assert.equal(toolConfig.tools.length, 1);
    const spec = toolConfig.tools[0].toolSpec;
    assert.equal(spec.name, "log_trip");
    assert.equal(spec.description, "Log a business trip in the car logbook.");
    assert.deepEqual(spec.inputSchema.json, {
      type: "object",
      properties: { km: { type: "number" }, purpose: { type: "string" } },
      required: ["km"],
      additionalProperties: false,
    });
    assert.equal(nameMap.get("log_trip"), "log_trip");
    // The original MCP tool object is not mutated.
    assert.ok(LOG_TRIP.inputSchema.$schema);
  });

  it("fills in a missing schema and description, and makes invalid names valid", () => {
    const { toolConfig, nameMap } = toConverseTools([
      { name: "odobook.status", title: "Car status" },
      { name: "odobook/status" },
    ]);
    const [a, b] = toolConfig.tools.map((t) => t.toolSpec);
    assert.equal(a.name, "odobook_status");
    assert.equal(a.description, "Car status");
    assert.deepEqual(a.inputSchema.json, { type: "object", properties: {} });
    assert.notEqual(b.name, a.name, "colliding sanitised names get a suffix");
    assert.match(b.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(b.description, "odobook/status");
    assert.equal(nameMap.get(a.name), "odobook.status");
    assert.equal(nameMap.get(b.name), "odobook/status");
  });

  it("returns no toolConfig when the server has no tools", () => {
    assert.equal(toConverseTools([]).toolConfig, undefined);
  });
});

// --- the tool-use loop --------------------------------------------------------

describe("createBedrockBrain turn loop", () => {
  it("runs toolUse -> MCP call -> toolResult -> final spoken text", async () => {
    const bedrock = fakeBedrock([
      toolUse("tu-1", "log_trip", { km: 42, purpose: "client visit" }, "Logging that."),
      endTurn("Logged a 42 kilometre trip for the client visit."),
    ]);
    const session = fakeSession([LOG_TRIP], () => text("Trip #7 saved: 42 km."));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    const { reply, trace } = await brain.turn("log 42 k for a client visit");

    assert.equal(reply, "Logged a 42 kilometre trip for the client visit.");
    assert.equal(brain.name, "bedrock");

    // The MCP tool was called once with the model's arguments.
    assert.deepEqual(session.toolCalls, [{ name: "log_trip", args: { km: 42, purpose: "client visit" } }]);
    assert.equal(trace.length, 1);
    assert.equal(trace[0].tool, "log_trip");
    assert.equal(trace[0].text, "Trip #7 saved: 42 km.");
    assert.equal(trace[0].isError, false);

    // First Converse request: model, system prompt, tools, the utterance.
    assert.equal(bedrock.calls.length, 2);
    const [first, second] = bedrock.calls;
    assert.equal(first.modelId, DEFAULT_MODEL_ID);
    assert.deepEqual(first.system, [{ text: DEFAULT_SYSTEM_PROMPT }]);
    assert.equal(first.toolConfig.tools[0].toolSpec.name, "log_trip");
    assert.ok(first.inferenceConfig.maxTokens > 0);
    assert.deepEqual(first.messages, [{ role: "user", content: [{ text: "log 42 k for a client visit" }] }]);

    // Second request replays the assistant toolUse and answers it with a toolResult.
    assert.equal(second.messages.length, 3);
    assert.equal(second.messages[1].role, "assistant");
    assert.equal(second.messages[1].content[1].toolUse.toolUseId, "tu-1");
    assert.deepEqual(second.messages[2], {
      role: "user",
      content: [
        { toolResult: { toolUseId: "tu-1", content: [{ text: "Trip #7 saved: 42 km." }], status: "success" } },
      ],
    });
  });

  it("keeps conversation history across turns and clears it on reset()", async () => {
    const bedrock = fakeBedrock([endTurn("Hi there."), endTurn("Still here."), endTurn("Fresh start.")]);
    const session = fakeSession([LOG_TRIP], () => text("unused"));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    await brain.turn("hello");
    await brain.turn("are you there");
    assert.equal(bedrock.calls[1].messages.length, 3, "user, assistant, user");
    assert.equal(bedrock.calls[1].messages[1].content[0].text, "Hi there.");

    brain.reset();
    await brain.turn("hello again");
    assert.equal(bedrock.calls[2].messages.length, 1);
  });

  it("replays reasoning blocks unchanged but never speaks them", async () => {
    const reasoning = { reasoningContent: { reasoningText: { text: "", signature: "sig-abc" } } };
    const bedrock = fakeBedrock([
      { output: { message: { role: "assistant", content: [reasoning, { text: "Done." }] } }, stopReason: "end_turn" },
      endTurn("Next."),
    ]);
    const session = fakeSession([], () => text("unused"));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    const { reply } = await brain.turn("first");
    assert.equal(reply, "Done.");
    await brain.turn("second");
    assert.deepEqual(bedrock.calls[1].messages[1].content[0], reasoning);
    assert.equal(bedrock.calls[1].toolConfig, undefined, "no toolConfig when there are no tools");
  });

  it("calls the original MCP name when the Converse name had to be sanitised", async () => {
    const tool = { name: "odobook.status", description: "Status", inputSchema: { type: "object", properties: {} } };
    const bedrock = fakeBedrock([toolUse("tu-1", "odobook_status", {}), endTurn("All good.")]);
    const session = fakeSession([tool], () => text("ok"));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    await brain.turn("status");
    assert.equal(session.toolCalls[0].name, "odobook.status");
  });

  it("stops after maxToolRounds and leaves history valid for the next turn", async () => {
    const bedrock = fakeBedrock([
      toolUse("a", "log_trip", { km: 1 }),
      toolUse("b", "log_trip", { km: 2 }),
      endTurn("Back to normal."),
    ]);
    const session = fakeSession([LOG_TRIP], () => text("ok"));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, maxToolRounds: 2, log: silentLog });

    const { reply, trace } = await brain.turn("loop forever");
    assert.match(reply, /too many steps/);
    assert.equal(trace.length, 2);

    await brain.turn("hello");
    assert.deepEqual(bedrock.calls[2].messages, [{ role: "user", content: [{ text: "hello" }] }]);
  });
});

// --- error handling -----------------------------------------------------------

describe("createBedrockBrain errors", () => {
  it("sends an MCP tool error back as a toolResult with status error", async () => {
    const bedrock = fakeBedrock([
      toolUse("tu-9", "log_trip", { km: -5 }),
      endTurn("Sorry, the logbook says the distance must be positive."),
    ]);
    const session = fakeSession([LOG_TRIP], () => ({ ...text("km must be positive"), isError: true }));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    const { reply, trace } = await brain.turn("log minus five k");

    assert.equal(trace[0].isError, true);
    assert.deepEqual(bedrock.calls[1].messages[2].content[0], {
      toolResult: { toolUseId: "tu-9", content: [{ text: "km must be positive" }], status: "error" },
    });
    assert.match(reply, /positive/);
  });

  it("never sends an empty text block in a toolResult", async () => {
    const bedrock = fakeBedrock([toolUse("tu-1", "log_trip", { km: 1 }), endTurn("Done.")]);
    const session = fakeSession([LOG_TRIP], () => ({ content: [], isError: true }));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    await brain.turn("log one k");
    const result = bedrock.calls[1].messages[2].content[0].toolResult;
    assert.equal(result.status, "error");
    assert.ok(result.content[0].text.length > 0);
  });

  it("turns Bedrock AccessDeniedException into a clear spoken error instead of throwing", async () => {
    const logged = [];
    const bedrock = fakeBedrock([
      awsError("AccessDeniedException", "You don't have access to the model with the specified model ID."),
      endTurn("Working now."),
    ]);
    const session = fakeSession([LOG_TRIP], () => text("unused"));
    const brain = createBedrockBrain({
      session: async () => session,
      client: bedrock,
      log: (msg) => logged.push(msg),
    });

    const { reply, trace } = await brain.turn("how far have I driven");
    assert.match(reply, /Amazon Bedrock/);
    assert.match(reply, /[Aa]ccess was denied/);
    assert.deepEqual(trace, []);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /AccessDeniedException/);

    // The failed turn was rolled back: the next request starts clean.
    const next = await brain.turn("try again");
    assert.equal(next.reply, "Working now.");
    assert.deepEqual(bedrock.calls[1].messages, [{ role: "user", content: [{ text: "try again" }] }]);
  });

  it("rolls back a failed turn mid-loop, keeping trace of the tool calls already made", async () => {
    const bedrock = fakeBedrock([toolUse("tu-1", "log_trip", { km: 3 }), awsError("ThrottlingException")]);
    const session = fakeSession([LOG_TRIP], () => text("saved"));
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    const { reply, trace } = await brain.turn("log three k");
    assert.match(reply, /rate limiting/);
    assert.equal(trace.length, 1, "the tool call that did run is still reported");
  });

  it("rethrows MCP transport failures (so the simulator relinks) after rolling back history", async () => {
    const bedrock = fakeBedrock([toolUse("tu-1", "log_trip", { km: 3 }), endTurn("Fine.")]);
    const session = fakeSession([LOG_TRIP], () => {
      throw new Error("Session not found");
    });
    const brain = createBedrockBrain({ session: async () => session, client: bedrock, log: silentLog });

    await assert.rejects(brain.turn("log three k"), /Session not found/);
    await brain.turn("hello");
    assert.deepEqual(bedrock.calls[1].messages, [{ role: "user", content: [{ text: "hello" }] }]);
  });

  it("has a spoken message for every common Bedrock error and a generic fallback", () => {
    for (const name of [
      "AccessDeniedException",
      "ResourceNotFoundException",
      "ValidationException",
      "ThrottlingException",
      "ModelNotReadyException",
      "CredentialsProviderError",
      "SomethingNew",
    ]) {
      const spoken = spokenBedrockError(awsError(name));
      assert.match(spoken, /^Sorry/);
      assert.doesNotMatch(spoken, /[*#`]/, "no markdown in spoken text");
    }
    assert.match(spokenBedrockError(undefined), /^Sorry/);
  });
});

// --- default client -----------------------------------------------------------

describe("createBedrockBrain defaults", () => {
  it("builds a real BedrockRuntimeClient for the requested region without calling AWS", async () => {
    const brain = createBedrockBrain({ session: async () => fakeSession([], () => text("")), region: "ap-southeast-2" });
    assert.equal(brain.region, "ap-southeast-2");
    assert.equal(brain.modelId, "global.amazon.nova-2-lite-v1:0");
  });
});
