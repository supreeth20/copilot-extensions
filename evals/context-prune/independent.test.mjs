import test from "node:test";
import assert from "node:assert/strict";
import {
  conversation, OPERATION_PREFIX, replacement, replaceObservations, validateSummary,
} from "../../extensions/context-prune/context.mjs";
import { searchHistory } from "../../extensions/context-prune/test-support/history.mjs";
import { createContextPrune } from "../../extensions/context-prune/runtime.mjs";

// Original independent retention/recovery oracles remain intact. Orchestration
// probes now target command-owned SDK execution, not the removed apply tool.
// All text, tool data, and identifiers below are synthetic.
const ORACLES = {
  fidelity: "Drop preserves ordered non-tool fields exactly, including Unicode and whitespace.",
  prefix: "A user's literal operation-prefix example is narrative, not a generated command.",
  multiplicity: "Repeated readable blocks within one representation retain their order and multiplicity.",
  mirrored: "A second mirrored representation must not duplicate the same readable blocks.",
  malformed: "Unknown provider JSON values do not crash extraction of adjacent readable blocks.",
  delimiter: "Literal serialization delimiters inside retained prose survive multiple drops.",
  boundary: "A completed native compaction replaces older state but retains work after its start.",
  unapplied: "Failed or unapplied native compactions cannot discard current state.",
  interrupted: "Interrupted unanswered calls become unsuccessful findings, never verified success.",
  late: "A late recorded completion supersedes an interruption placeholder.",
  repeated: "Multi-round drops are idempotent for prior findings and non-tool narrative.",
  mixed: "Compact then drop does not resurrect the pre-summary raw tool outputs.",
  history: "Pinned paginated recovery reconstructs the original result despite later events.",
  historyErrors: "Invalid recovery input and missing snapshots fail explicitly.",
  historyBlocks: "Readable text available only in reasoningBlocks remains discoverable after compact.",
  checkpoint: "Exact checkpoint write and readback precede any clear; the original journal survives.",
  auth: "No model-controlled apply authority exists and wrong-session commands cannot modify context.",
  guards: "Queue, steering, processing, pending tools, permissions and tasks block preparation.",
  stale: "New information while saving a checkpoint prevents clear and invalidates authorization.",
  concurrent: "Only one simultaneous command can clear; cancel cannot interrupt clearing after it starts.",
  mismatch: "Checkpoint mismatch fails without clear; a new explicit command can save a fresh checkpoint.",
  uncertain: "A clear RPC failure is ambiguous, mandates reload and cannot be retried.",
  attachments: "Both reductions preserve document references without relying on model-written prose.",
  separation: "Tool findings and working-state summaries are mutually exclusive inputs.",
  recoveryFailure: "Recovering a failed tool retains both its textual evidence and error diagnostics.",
  semanticRounds: "Semantic multi-round fidelity holds independently of serialized JSON key order.",
  historyTransformed: "Distinct model-transformed user constraints remain searchable after compact.",
  historyFailureStatus: "Call-ID recovery explicitly distinguishes failed output from successful evidence.",
};

let nextEvent = 0;
const event = (type, data = {}, extra = {}) => ({ id: `synthetic-event-${++nextEvent}`, type, data, ...extra });
const user = (content, extra = {}) => event("user.message", { content, ...extra });
const assistant = (content, extra = {}) => event("assistant.message", { content, ...extra });
const start = (id = "call-a", name = "diagnostic") =>
  event("tool.execution_start", { toolCallId: id, toolName: name, arguments: { label: "synthetic" } });
const complete = (id = "call-a", text = "RAW-SYNTHETIC-OUTPUT") =>
  event("tool.execution_complete", { toolCallId: id, success: true, result: { content: text } });
const baseline = () => [user("Keep the offline requirement."), start(), complete(), assistant("Verified diagnostic.")];
const summary = ["Goal", "Constraints", "State", "Decisions", "Next", "References"]
  .map((heading) => `## ${heading}\nSynthetic ${heading.toLowerCase()} evidence.`).join("\n\n");
const findings = (messages) => messages.filter((message) => message.role === "tool")
  .map(({ callId }) => ({ callId, finding: `Verified finding for ${callId}.` }));
const drop = (events) => replacement("tools", replaceObservations(conversation(events).messages, findings(conversation(events).messages)), "synthetic-session");
const installed = (prompt) => [
  event("session.context_cleared", { initialMessage: prompt }),
  user("", { transformedContent: `<environment>${prompt}</environment>` }),
  assistant("Context saved. Exit Copilot, then run: copilot --resume synthetic-session"),
  event("session.resume"),
];

function harness(events = baseline()) {
  const state = {
    events, trace: [], checkpoints: new Map(), queue: { items: [], steeringMessages: [] },
    pending: { items: [] }, tasks: { tasks: [] }, permissions: { items: [] },
    processing: false, hooks: {}, clears: 0, requests: [],
  };
  const session = {
    sessionId: "synthetic-session",
    getEvents: async () => [...state.events],
    send: async () => { throw new Error("Main-agent prompting is forbidden"); },
    setTools: async () => { throw new Error("Extension connections cannot replace SDK external tools"); },
    rpc: {
      model: { getCurrent: async () => ({ modelId: "synthetic-model" }) },
      queue: { pendingItems: async () => state.queue },
      tools: {
        listPendingRequests: async () => state.pending,
        execute: async ({ name, arguments: args, toolCallId }) => {
          const invocation = { sessionId: session.sessionId, toolCallId, requestId: `request-${toolCallId}` };
          state.events.push(event("external_tool.requested", { ...invocation, toolName: name }));
          state.pending.items.push({ ...invocation, toolName: name });
          try {
            await extension.tools.find((tool) => tool.name === name).handler(args, invocation);
            return { resultType: "success" };
          } finally {
            state.pending.items = state.pending.items.filter((item) => item.requestId !== invocation.requestId);
          }
        },
      },
      tasks: { list: async () => state.tasks },
      permissions: { pendingRequests: async () => state.permissions },
      metadata: { isProcessing: async () => ({ processing: state.processing }) },
      log: async ({ ephemeral }) => { if (!ephemeral) state.trace.push("log"); },
      workspaces: {
        getWorkspace: async () => ({ workspace: { cwd: "/synthetic" } }),
        addSummary: async ({ content }) => {
          state.trace.push("save");
          const number = state.checkpoints.size + 1;
          state.checkpoints.set(number, content);
          await state.hooks.save?.();
          return { summary: { checkpointNumber: number } };
        },
        readCheckpoint: async ({ number }) => {
          state.trace.push("read");
          await state.hooks.read?.();
          return { content: state.mismatch ? "CORRUPT" : state.checkpoints.get(number) };
        },
      },
      history: {
        clearContext: async ({ prompt }) => {
          state.trace.push("clear");
          await state.hooks.clear?.();
          state.clears++;
          state.events.push(event("session.context_cleared", { initialMessage: prompt }));
          return { messagesCleared: 4 };
        },
      },
    },
  };
  const extension = createContextPrune(() => session, { generate: async (request) => {
    state.trace.push("generate");
    state.requests.push(request);
    await state.hooks.generate?.();
    if (state.output) return state.output;
    return request.responseSchema.required[0] === "summary" ? { summary } : { observations: findings(conversation(events).messages) };
  } });
  const command = (name, sessionId = session.sessionId) => extension.commands.find((entry) => entry.name === name).handler({ sessionId });
  const prepare = (mode = "tools", sessionId = session.sessionId) =>
    command(mode === "tools" ? "context-drop-tools" : "context-compact", sessionId);
  return { state, prepare, command, extension };
}

test(ORACLES.fidelity, () => {
  const text = " \tUnicode: e\u0301 🧭 İ\0\r\nsecond line \n";
  const events = [
    user(text, { transformedContent: `${text} transformed` }),
    assistant(text, { reasoningText: `Synthetic reasoning ${text}`, phase: "commentary", citations: [{ url: "https://example.invalid" }] }),
    event("assistant.reasoning", { content: `Synthetic completed reasoning ${text}` }),
    event("system.notification", { content: text }), start(), complete(),
  ];
  const before = conversation(events).messages.filter((m) => m.role !== "tool");
  const after = conversation([...events, ...installed(drop(events))]).messages.filter((m) => m.role !== "finding");
  assert.deepEqual(after, before);
});

test(ORACLES.prefix, () => {
  const text = `${OPERATION_PREFIX}This is a literal documentation example. Do not remove it.`;
  assert.equal(conversation([user(text, { source: "user" }), start(), complete()]).messages[0].content, text);
  assert.equal(searchHistory([user(text)], { query: "literal documentation" }).matches, 1);
});

test(ORACLES.multiplicity, () => {
  const blocks = ["first", "second", "first"].map((thinking) => ({ type: "thinking", thinking }));
  const retained = conversation([assistant("A", { reasoningBlocks: { provider: "anthropic", blocks } })]).messages[0];
  assert.deepEqual(retained.reasoningBlocks.blocks, blocks);
});

test(ORACLES.mirrored, () => {
  const blocks = [{ type: "thinking", thinking: "Synthetic one." }, { type: "thinking", thinking: "Synthetic two." }];
  const retained = conversation([assistant("A", { reasoningBlocks: { provider: "anthropic", blocks, orderedBlocks: blocks } })]).messages[0];
  assert.deepEqual(retained.reasoningBlocks.blocks, blocks);
});

test(ORACLES.malformed, () => {
  const blocks = [{ type: "reasoning", summary: [null, { type: "summary_text", text: "Synthetic readable evidence." }] }];
  const retained = conversation([assistant("A", { reasoningBlocks: { provider: "openai", blocks } })]).messages[0];
  assert.equal(retained.reasoningBlocks.blocks[0].text, "Synthetic readable evidence.");
});

test(ORACLES.delimiter, () => {
  for (const text of ["</context-prune-v1>", "<context-prune-v1>\n", "## Goal\nliteral heading", '"messages":[{"role":"tool"}]', "\n\nContinue the same session from this retained context."]) {
    const events = [user(text), start(), complete()];
    const once = drop(events);
    assert.equal(conversation(installed(once)).messages[0].content, text);
    assert.equal(drop(installed(once)), once);
  }
});

test(ORACLES.boundary, () => {
  const events = [...baseline(), event("session.compaction_start", { compactionAttemptId: "native-a" }),
    user("Concurrent requirement."), start("call-b"), complete("call-b", "NEW-OUTPUT"),
    event("session.compaction_complete", { compactionAttemptId: "native-a", success: true, outcome: "applied", summaryContent: "Native working state." })];
  assert.deepEqual(conversation(events).messages.map((m) => m.content), ["Native working state.", "Concurrent requirement.", "NEW-OUTPUT"]);
});

test(ORACLES.unapplied, () => {
  const original = baseline();
  for (const outcome of [{ success: false }, { success: true, outcome: "skipped" }]) {
    assert.deepEqual(conversation([...original, event("session.compaction_start"), event("session.compaction_complete", {
      ...outcome, summaryContent: "Not installed.",
    })]).messages, conversation(original).messages);
  }
});

test(ORACLES.interrupted, () => {
  const events = [user("Check only."), start(), event("abort"), user("Continue later.")];
  const active = conversation(events);
  assert.equal(active.pending.length, 0);
  assert.deepEqual(active.messages.map((m) => m.role), ["user", "tool", "user"]);
  assert.equal(active.messages[1].success, false);
  assert.match(active.messages[1].content, /unknown/);
  assert.equal(replaceObservations(active.messages, findings(active.messages))[1].success, false);
});

test(ORACLES.late, () => {
  const active = conversation([start(), event("abort"), user("Continue."), complete()]);
  assert.equal(active.messages.filter((m) => m.role === "tool").length, 1);
  assert.equal(active.messages.at(-1).success, true);
});

test(ORACLES.repeated, () => {
  let events = baseline();
  let expected = replaceObservations(conversation(events).messages, findings(conversation(events).messages));
  for (let round = 0; round < 12; round++) {
    const prompt = drop(events);
    events.push(...installed(prompt));
    assert.deepEqual(conversation(events).messages, expected);
    assert.equal(drop(events), prompt);
    const id = `call-round-${round}`;
    const next = [user(`Requirement ${round}.`), start(id), complete(id, `RAW-${round}`)];
    events.push(...next);
    expected.push({ role: "user", content: `Requirement ${round}.` }, { role: "finding", name: "diagnostic", callId: id, success: true, content: `Verified finding for ${id}.` });
  }
});

test(ORACLES.mixed, () => {
  const events = baseline();
  events.push(...installed(drop(events)));
  events.push(...installed(replacement("compact", summary, "synthetic-session")));
  events.push(user("Verify next step."), start("call-new"), complete("call-new", "RAW-NEW"));
  const retained = conversation(installed(drop(events))).messages;
  assert.equal(retained[0].content, summary);
  assert.deepEqual(retained.map((m) => m.role), ["user", "user", "finding"]);
  assert.ok(!JSON.stringify(retained).includes("RAW-"));
  assert.match(searchHistory(events, { callId: "call-a" }).content, /RAW-SYNTHETIC-OUTPUT/);
});

test(ORACLES.history, () => {
  const text = "🧪 synthetic diagnostic\r\n".repeat(90);
  const events = [start(), complete("call-a", text)];
  const whole = searchHistory(events, { callId: "call-a", limit: 12000 });
  let result = searchHistory(events, { callId: "call-a", limit: 17 });
  let joined = result.content;
  events.push(start("later"), complete("later", "Must not shift the pinned page."));
  while (result.nextOffset !== null) {
    result = searchHistory(events, { callId: "call-a", limit: 17, offset: result.nextOffset, beforeEventId: result.beforeEventId });
    joined += result.content;
  }
  assert.equal(joined, whole.content);
  assert.equal(JSON.parse(joined).content, text);
  assert.equal(searchHistory(events, { callId: "missing" }).matches, 0);
});

test(ORACLES.historyErrors, () => {
  const events = baseline();
  for (const args of [{}, { query: "x", offset: 1 }, { query: "x", limit: 0 }, { query: "x", offset: -1 }, { query: "x", limit: 12001 }, { query: "x", beforeEventId: "missing" }]) {
    assert.throws(() => searchHistory(events, args));
  }
});

test(ORACLES.historyBlocks, () => {
  const events = [assistant("Synthetic answer.", { reasoningBlocks: {
    provider: "anthropic", blocks: [{ type: "thinking", thinking: "SYNTHETIC-RECOVERABLE-RATIONALE" }],
  } }), ...installed(replacement("compact", summary, "synthetic-session"))];
  assert.equal(searchHistory(events, { query: "SYNTHETIC-RECOVERABLE-RATIONALE" }).matches, 1);
});

test(ORACLES.checkpoint, async () => {
  const h = harness();
  const original = structuredClone(h.state.events);
  await h.prepare();
  assert.deepEqual(h.state.trace.slice(0, 4), ["generate", "save", "read", "clear"]);
  assert.equal(h.state.checkpoints.get(1), h.state.events.at(-1).data.initialMessage);
  assert.deepEqual(h.state.events.slice(0, original.length), original);
  assert.equal(h.state.events.filter((entry) => entry.type === "user.message").length, 1);
  h.state.processing = false;
  await assert.rejects(h.prepare(), /Reload this session first/);
});

test(ORACLES.auth, async () => {
  const h = harness();
  assert.deepEqual(h.extension.tools.map(({ name }) => name), ["context_commit"]);
  await assert.rejects(h.extension.tools[0].handler({}, { sessionId: "synthetic-session", toolCallId: "model-chosen" }), /Only the command/);
  await assert.rejects(h.prepare("tools", "other-session"), /scope mismatch/);
  assert.equal(h.state.clears, 0);
  assert.equal(h.state.requests.length, 0);
  await h.prepare();
  assert.equal(h.state.clears, 1);
});

test(ORACLES.guards, async () => {
  const cases = [
    ["queue", { items: [{}], steeringMessages: [] }],
    ["queue", { items: [], steeringMessages: [{}] }],
    ["queue", { items: [], steeringMessages: [], withdrawableTurnMessageId: "queued" }],
    ["processing", true], ["pending", { items: [{ toolName: "diagnostic" }] }],
    ["permissions", { items: [{}] }],
    ...["running", "idle", "orphaned"].map((status) => ["tasks", { tasks: [{ status }] }]),
  ];
  for (const [field, value] of cases) {
    const h = harness();
    h.state[field] = value;
    await assert.rejects(h.prepare());
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.clears, 0);
  }
});

test(ORACLES.stale, async () => {
  for (const extra of [user("New prohibition."), event("system.notification", { content: "New runtime information." }), start("other"), event("abort")]) {
    const h = harness();
    h.state.hooks.read = async () => h.state.events.push(extra);
    await assert.rejects(h.prepare(), /Context was not cleared/);
    assert.equal(h.state.clears, 0);
    assert.equal(h.state.checkpoints.size, 1);
    await assert.rejects(h.extension.tools[0].handler({}, { sessionId: "synthetic-session", toolCallId: "expired" }), /Only the command/);
  }
});

test(ORACLES.concurrent, async () => {
  const h = harness();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  h.state.hooks.save = async () => { entered(); await gate; };
  const applying = h.prepare();
  await ready;
  try {
    await assert.rejects(h.prepare(), /already active/);
    h.state.hooks.clear = async () => {
      await assert.rejects(h.command("context-cancel"), /clearing has started/);
    };
  } finally {
    release();
    await applying;
  }
  assert.equal(h.state.clears, 1);
});

test(ORACLES.mismatch, async () => {
  const h = harness();
  h.state.mismatch = true;
  await assert.rejects(h.prepare(), /checkpoint does not match/);
  assert.equal(h.state.clears, 0);
  h.state.mismatch = false;
  await h.prepare();
  assert.equal(h.state.checkpoints.size, 2);
  assert.equal(h.state.clears, 1);
});

test(ORACLES.uncertain, async () => {
  const h = harness();
  h.state.hooks.clear = async () => { throw new Error("Synthetic transport disconnection"); };
  await assert.rejects(h.prepare(), /clearing was attempted.*do not retry/);
  h.state.processing = false;
  await assert.rejects(h.prepare(), /Reload this session first/);
  assert.equal(h.state.checkpoints.size, 1);
});

test(ORACLES.attachments, async () => {
  for (const mode of ["tools", "compact"]) {
    const events = baseline();
    events[0].data.attachments = [{ type: "file", path: "synthetic.pdf" }];
    const h = harness(events);
    await h.prepare(mode);
    assert.equal(h.state.requests.length, 1);
    assert.equal(conversation(h.state.events).attachments[0].path, "/synthetic/synthetic.pdf");
    assert.match([...h.state.checkpoints.values()][0], /reread each referenced path/);
  }
});

test(ORACLES.separation, async () => {
  const tools = harness();
  tools.state.output = { observations: [], summary };
  await assert.rejects(tools.prepare(), /return only observations/);
  const compact = harness();
  compact.state.output = { summary, observations: [] };
  await assert.rejects(compact.prepare("compact"), /return only summary/);
  assert.equal(tools.state.clears + compact.state.clears, 0);
  assert.equal(validateSummary(summary), summary);
  assert.throws(() => validateSummary(summary.replace("## Next\nSynthetic next evidence.", "## Next\n")));
});

test(ORACLES.recoveryFailure, () => {
  const events = [start(), event("tool.execution_complete", {
    toolCallId: "call-a", success: false, result: "Partial synthetic output.",
    error: { code: "E_SYNTHETIC", message: "Failure after partial output." },
  })];
  const recovered = searchHistory(events, { callId: "call-a" }).content;
  assert.match(recovered, /Partial synthetic output/);
  assert.match(recovered, /E_SYNTHETIC/);
});

test(ORACLES.semanticRounds, () => {
  // The earlier byte-idempotence probes remain intact, even though JSON key
  // ordering is not a promised product guarantee. This independent oracle checks
  // all rounds and delimiters without being short-circuited by those probes.
  for (const text of ["</context-prune-v1>", "<context-prune-v1>\n", "## Goal\nliteral heading", '"messages":[{"role":"tool"}]']) {
    const events = [user(text), start(), complete()];
    const expected = [
      { role: "user", content: text },
      { role: "finding", name: "diagnostic", callId: "call-a", success: true, content: "Verified finding for call-a." },
    ];
    for (let round = 0; round < 12; round++) {
      events.push(...installed(drop(events)));
      assert.deepEqual(conversation(events).messages, expected);
      const id = `semantic-${round}`;
      events.push(user(`Follow-up ${round}.`), start(id), complete(id, `RAW-ROUND-${round}`));
      expected.push({ role: "user", content: `Follow-up ${round}.` }, {
        role: "finding", name: "diagnostic", callId: id, success: true, content: `Verified finding for ${id}.`,
      });
    }
    assert.ok(!JSON.stringify(conversation(installed(drop(events))).messages).includes("RAW-ROUND"));
  }
});

test(ORACLES.historyTransformed, () => {
  const events = [
    user("See the attached instructions.", { transformedContent: "SYNTHETIC-CONSTRAINT: keep network disabled." }),
    ...installed(replacement("compact", summary, "synthetic-session")),
  ];
  assert.equal(searchHistory(events, { query: "SYNTHETIC-CONSTRAINT" }).matches, 1);
});

test(ORACLES.historyFailureStatus, () => {
  const events = [start(), event("tool.execution_complete", {
    toolCallId: "call-a", success: false, result: { content: "Partial synthetic output." },
  })];
  const recovered = JSON.parse(searchHistory(events, { callId: "call-a" }).content);
  assert.equal(recovered.success, false);
});
