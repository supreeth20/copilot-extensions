import test from "node:test";
import assert from "node:assert/strict";
import { conversation } from "./context.mjs";
import { createContextPrune } from "./runtime.mjs";

const summary = ["Goal", "Constraints", "State", "Decisions", "Next", "References"]
  .map((heading) => `## ${heading}\nRetained ${heading.toLowerCase()}.`).join("\n\n");
let sequence = 0;
const event = (type, data = {}, extra = {}) => ({ id: `runtime-${++sequence}`, type, data, ...extra });
function harness() {
  const state = {
    events: [
      event("user.message", { content: "Private user narrative; preserve case; no deployment." }),
      event("tool.execution_start", { toolCallId: "test-call", toolName: "diagnostic", arguments: { command: "node --test" } }),
      event("tool.execution_complete", { toolCallId: "test-call", success: false, result: { content: "FAILED assertion at test.js:7" } }),
    ],
    queue: { items: [], steeringMessages: [] }, pending: { items: [] }, tasks: { tasks: [] },
    permissions: { items: [] }, processing: false, calls: [], requests: [], checkpoints: new Map(), hooks: {},
  };
  const session = {
    sessionId: "same-session",
    getEvents: async () => structuredClone(state.events),
    send: async () => { throw new Error("Commands must never prompt the main agent"); },
    setTools: async () => { throw new Error("Extension connections cannot replace SDK external tools"); },
    rpc: {
      model: { getCurrent: async () => ({ modelId: "selected-model", contextTier: "long_context" }) },
      queue: { pendingItems: async () => state.queue },
      tools: {
        listPendingRequests: async () => state.pending,
        execute: async ({ name, arguments: args, toolCallId }) => {
          state.calls.push("execute");
          const invocation = { toolCallId, requestId: `request-${toolCallId}`, sessionId: session.sessionId };
          state.invocation = invocation;
          state.events.push(event("external_tool.requested", { ...invocation, toolName: name }));
          state.pending.items.push({ ...invocation, toolName: name });
          try {
            await state.hooks.execute?.(invocation);
            if (state.failExecute) throw new Error("SDK invocation failed");
            await extension.tools.find((tool) => tool.name === name).handler(args, invocation);
            return { resultType: "success" };
          } finally {
            state.pending.items = state.pending.items.filter((item) => item.requestId !== invocation.requestId);
            state.events.push(event("external_tool.completed", { requestId: invocation.requestId }));
          }
        },
      },
      tasks: { list: async () => state.tasks }, permissions: { pendingRequests: async () => state.permissions },
      metadata: { isProcessing: async () => ({ processing: state.processing }) },
      workspaces: {
        addSummary: async ({ content }) => {
          state.calls.push("checkpoint");
          if (state.failSave) throw new Error("save failed");
          const number = state.checkpoints.size;
          state.checkpoints.set(number, content);
          await state.hooks.save?.();
          return { summary: { checkpointNumber: number } };
        },
        readCheckpoint: async ({ number }) => {
          state.calls.push("read");
          await state.hooks.read?.();
          return { content: state.corrupt ? "corrupt" : state.checkpoints.get(number) };
        },
      },
      history: { clearContext: async ({ prompt }) => {
        state.calls.push("clear");
        await state.hooks.clear?.();
        if (state.failClear) throw new Error("connection lost");
        state.events.push(event("session.context_cleared", { initialMessage: prompt }));
        return { messagesCleared: 3 };
      } },
      log: async ({ message }) => {
        if (state.failLog) throw new Error("logging failed");
        state.calls.push("log");
        state.lastLog = message;
      },
    },
  };
  const generate = async (request) => {
    state.calls.push("generate");
    state.requests.push(request);
    await state.hooks.generate?.(request);
    if (state.failGeneration) throw new Error("generation failed");
    if (Object.hasOwn(state, "output")) return state.output;
    return request.responseSchema.required[0] === "summary" ? { summary } : {
      observations: [{ callId: "test-call", finding: "node --test failed at test.js:7; not verified fixed." }],
    };
  };
  const extension = createContextPrune(() => session, { generate });
  const invoke = (mode = "tools", args = "", sessionId = session.sessionId) =>
    extension.commands.find((command) => command.name === (mode === "tools" ? "context-drop-tools" : "context-compact"))
      .handler({ sessionId, args });
  const cancel = () => extension.commands.find((command) => command.name === "context-cancel").handler({ sessionId: session.sessionId });
  return { state, session, extension, invoke, cancel };
}

test("only an inert SDK-required adapter exists; no model-controlled apply or history tool", async () => {
  const h = harness();
  assert.deepEqual(h.extension.tools.map(({ name }) => name), ["context_commit"]);
  await assert.rejects(h.extension.tools[0].handler({}, { sessionId: "same-session", toolCallId: "model-chosen" }), /Only the command/);
  assert.equal(h.extension.commands.length, 3);
});

for (const mode of ["tools", "compact"]) {
  test(`${mode} command alone generates, validates, checkpoints and clears without a main-agent turn`, async () => {
    const h = harness();
    const before = structuredClone(h.state.events);
    await h.invoke(mode);
    assert.deepEqual(h.state.calls, ["generate", "checkpoint", "read", "execute", "clear", "log"]);
    assert.deepEqual(h.state.events.slice(0, before.length), before);
    assert.equal(h.state.checkpoints.get(0), h.state.events.findLast((entry) => entry.type === "session.context_cleared").data.initialMessage);
    await assert.rejects(h.extension.tools[0].handler({}, h.state.invocation), /Only the command/);
    assert.match(h.state.lastLog, /copilot --resume same-session/);
    assert.equal(h.state.requests[0].model, "selected-model");
    assert.equal(h.state.requests[0].contextTier, "long_context");
    await assert.rejects(h.invoke(), /Reload this session first/);
  });
}

test("drop gives the generator only tool evidence, never narrative to rewrite", async () => {
  const h = harness();
  await h.invoke("tools", "retain assertions");
  const request = h.state.requests[0];
  assert.match(request.prompt, /NOT conversation compaction/);
  assert.match(request.prompt, /FAILED assertion at test.js:7/);
  assert.match(request.prompt, /retain assertions/);
  assert.doesNotMatch(request.prompt, /Private user narrative|## Goal|context_apply|context_history/);
  assert.equal(request.responseSchema.required[0], "observations");
  const messages = conversation(h.state.events).messages;
  assert.equal(messages[0].content, "Private user narrative; preserve case; no deployment.");
  assert.equal(messages[1].success, false);
});

test("compact alone receives the skill and full active narrative", async () => {
  const h = harness();
  await h.invoke("compact");
  assert.match(h.state.requests[0].prompt, /# Context compaction/);
  assert.match(h.state.requests[0].prompt, /Private user narrative/);
  assert.equal(h.state.requests[0].responseSchema.required[0], "summary");
  assert.deepEqual(conversation(h.state.events).messages, [{ role: "user", content: summary }]);
});

test("compact receives attachment requirements and binary recovery evidence that drop refuses", async () => {
  const h = harness();
  const selection = { type: "selection", displayName: "Review requirements", filePath: "/fixture/ReviewCase.ts",
    selection: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
    text: "Never deploy. Require REVIEW_ATTACHMENT_9 approval." };
  h.state.events[0].data.attachments = [
    selection,
    { type: "blob", displayName: "Review diagram", mimeType: "image/png", assetId: "sha256:review",
      data: "ATTACHMENT_BINARY_BYTES" },
  ];
  h.state.events[2].data.result.binaryResultsForLlm = [
    { type: "image_ref", assetId: "sha256:tool-capture", mimeType: "image/png", byteLength: 10,
      description: "Unverified diagnostic capture", metadata: { path: "/fixture/capture.png" } },
  ];
  const original = structuredClone(h.state.events);
  await assert.rejects(h.invoke("tools"), /use \/context-compact/);
  assert.equal(h.state.requests.length, 0);
  await h.invoke("compact");
  const request = h.state.requests[0];
  const payload = JSON.parse(request.prompt.split("\n\n").at(-1));
  assert.deepEqual(payload.messages[0].attachments[0], selection);
  assert.equal(payload.messages[0].attachments[1].assetId, "sha256:review");
  for (const evidence of ["sha256:tool-capture", "Unverified diagnostic capture", "/fixture/capture.png"]) {
    assert(request.prompt.includes(evidence));
  }
  assert.match(request.prompt, /not inspected|not available/i);
  assert.match(request.prompt, /attachment/i);
  assert.doesNotMatch(request.prompt, /ATTACHMENT_BINARY_BYTES/);
  assert.deepEqual(h.state.events.slice(0, original.length), original);
});

for (const output of [
  null, "", [], { summary }, { observations: [], summary }, { observations: [] },
  { observations: [{ callId: "unknown", finding: "invented" }] },
  { observations: [{ callId: "test-call", finding: "valid text", action: "apply" }] },
  { observations: [{ callId: "test-call", finding: "x".repeat(12001) }] },
]) {
  test(`invalid drop output ${JSON.stringify(output)?.slice(0, 65)} cannot checkpoint or clear`, async () => {
    const h = harness();
    h.state.output = output;
    await assert.rejects(h.invoke(), /Context was not cleared/);
    assert(!h.state.calls.includes("checkpoint") && !h.state.calls.includes("clear"));
  });
}

test("invalid summary stops the command; a new explicit invocation can retry", async () => {
  const h = harness();
  h.state.output = { summary: "missing headings" };
  await assert.rejects(h.invoke("compact"), /Context was not cleared/);
  assert.equal(h.state.checkpoints.size, 0);
  delete h.state.output;
  await h.invoke("compact");
  assert.equal(h.state.calls.filter((call) => call === "clear").length, 1);
});

for (const [field, value] of [
  ["queue", { items: [{}], steeringMessages: [] }],
  ["queue", { items: [], steeringMessages: ["queued"] }],
  ["queue", { items: [], steeringMessages: [], withdrawableTurnMessageId: "starting" }],
  ["pending", { items: [{ toolName: "context_apply" }] }],
  ["permissions", { items: [{}] }], ["processing", true],
  ...["running", "idle", "orphaned"].map((status) => ["tasks", { tasks: [{ status }] }]),
]) {
  test(`${field} blocks before generation and again before checkpoint`, async () => {
    const before = harness();
    before.state[field] = value;
    await assert.rejects(before.invoke());
    assert(!before.state.calls.includes("generate"));
    const after = harness();
    after.state.hooks.generate = async () => { after.state[field] = value; };
    await assert.rejects(after.invoke());
    assert(!after.state.calls.includes("checkpoint") && !after.state.calls.includes("clear"));
  });
}

for (const type of ["user.message", "assistant.message", "system.notification", "abort", "tool.execution_start",
  "tool.execution_complete", "session.compaction_start", "session.truncation", "session.snapshot_rewind"]) {
  test(`${type} during generation or checkpoint readback prevents clear`, async () => {
    for (const phase of ["generate", "read"]) {
      const h = harness();
      h.state.hooks[phase] = async () => { h.state.events.push(event(type, { content: "new information" })); };
      await assert.rejects(h.invoke(), /Session history changed/);
      assert(!h.state.calls.includes("clear"));
      assert.equal(h.state.checkpoints.size, phase === "read" ? 1 : 0);
    }
  });
}

test("subagent activity invalidates the snapshot and wrong-session commands never generate", async () => {
  const h = harness();
  await assert.rejects(h.invoke("tools", "", "another-session"), /scope mismatch/);
  assert.equal(h.state.requests.length, 0);
  h.state.hooks.generate = async () => { h.state.events.push(event("assistant.message", { content: "child" }, { agentId: "child" })); };
  await assert.rejects(h.invoke(), /history changed/);
  assert(!h.state.calls.includes("clear"));
});

test("cancellation aborts the generator; concurrent commands cannot take over", async () => {
  const h = harness();
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  h.state.hooks.generate = async ({ signal }) => {
    entered();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const running = h.invoke();
  await ready;
  await assert.rejects(h.invoke(), /already active/);
  await h.cancel();
  await assert.rejects(running, /canceled/);
  assert.equal(h.state.requests[0].signal.aborted, true);
  assert(!h.state.calls.includes("clear") && !h.state.calls.includes("checkpoint"));
});

test("cancel during checkpoint readback leaves a prepared checkpoint but never clears", async () => {
  const h = harness();
  h.state.hooks.read = async () => { await h.cancel(); };
  await assert.rejects(h.invoke(), /checkpoint 0 was saved.*canceled/);
  assert.equal(h.state.checkpoints.size, 1);
  assert(!h.state.calls.includes("clear"));
});

test("clear cannot be canceled after it starts", async () => {
  const h = harness();
  h.state.hooks.clear = async () => { await assert.rejects(h.cancel(), /clearing has started/); };
  await h.invoke();
  assert.equal(h.state.calls.filter((call) => call === "clear").length, 1);
});

test("the adapter rejects model-directed and subagent invocations even during authorization", async () => {
  const h = harness();
  h.state.hooks.execute = async (invocation) => {
    const handler = h.extension.tools[0].handler;
    for (const changes of [{ toolCallId: "model-chosen" }, { agentId: "child" }, { sessionId: "wrong-session" }]) {
      await assert.rejects(handler({}, { ...invocation, ...changes }), /Only the command/);
    }
  };
  await h.invoke();
  assert.equal(h.state.calls.filter((call) => call === "clear").length, 1);
});

test("new input between authorization and SDK invocation prevents clearing", async () => {
  const h = harness();
  h.state.hooks.execute = async () => { h.state.events.push(event("user.message", { content: "new requirement" })); };
  await assert.rejects(h.invoke(), /history changed/);
  assert(!h.state.calls.includes("clear"));
  await assert.rejects(h.extension.tools[0].handler({}, { sessionId: "same-session", toolCallId: "model-chosen" }), /Only the command/);
});

test("SDK invocation failure revokes authorization and an expired adapter cannot clear", async () => {
  const h = harness();
  h.state.failExecute = true;
  await assert.rejects(h.invoke(), /Context was not cleared.*SDK invocation failed/);
  await assert.rejects(h.extension.tools[0].handler({}, { sessionId: "same-session", toolCallId: "anything" }), /Only the command/);
  assert(!h.state.calls.includes("clear"));
});

test("save, readback and generation failures never clear", async () => {
  for (const field of ["failSave", "corrupt", "failGeneration"]) {
    const h = harness();
    h.state[field] = true;
    await assert.rejects(h.invoke(), /Context was not cleared/);
    assert(!h.state.calls.includes("clear"));
  }
});

test("ambiguous clear failure and post-clear logging failure both require reload", async () => {
  for (const failure of ["clear", "log"]) {
    const h = harness();
    if (failure === "clear") h.state.failClear = true;
    else h.state.hooks.clear = async () => { h.state.failLog = true; };
    await assert.rejects(h.invoke(), /clearing was attempted.*do not retry/);
    await assert.rejects(h.invoke(), /Reload this session first/);
    assert.equal(h.state.checkpoints.size, 1);
  }
});

test("logging failure preserves the original command error", async () => {
  const h = harness();
  h.state.processing = true;
  h.state.failLog = true;
  await assert.rejects(h.invoke(), (error) => error instanceof AggregateError && /still processing/.test(error.message) && error.errors.length === 2);
});

test("preconditions reject empty, attached, tool-free and actively compacting histories", async () => {
  for (const [mutate, expected] of [
    [(state) => { state.events = []; }, /No conversation/],
    [(state) => { state.events = state.events.slice(0, 1); }, /No unpruned/],
    [(state) => { state.events[0].data.attachments = [{}]; }, /attachments/],
    [(state) => { state.events[2].data.result = { binaryResultsForLlm: [{}] }; }, /attachments/],
    [(state) => { state.events.push(event("session.compaction_start")); }, /compaction is in progress/],
    [(state) => { state.events.push(event("assistant.turn_start")); }, /agent is still responding/],
    [(state) => { state.events.pop(); }, /Unfinished tool calls/],
  ]) {
    const h = harness();
    mutate(h.state);
    await assert.rejects(h.invoke(), expected);
    assert.equal(h.state.requests.length, 0);
  }
});
