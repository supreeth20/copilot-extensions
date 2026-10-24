import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUnchanged, conversation, manifest, replacement,
  replaceObservations, resultText, searchHistory, validateSummary,
} from "./context.mjs";
import { createContextPrune } from "./runtime.mjs";

let sequence = 0;
const event = (type, data = {}, extra = {}) => ({ id: `event-${++sequence}`, type, data, ...extra });
const user = (content) => event("user.message", { content });
const assistant = (content, toolRequests) => event("assistant.message", { content, toolRequests });
function fixture() {
  return [
    user("Preserve Case; never deploy. Ελληνικά."),
    assistant("Checking the failure.", [{ toolCallId: "call-1", name: "test", arguments: { command: "npm test" } }]),
    event("tool.execution_start", { toolCallId: "call-1", toolName: "test", arguments: { command: "npm test" } }),
    event("tool.execution_complete", { toolCallId: "call-1", success: false, result: { content: "preview", detailedContent: "FAILED at src/check.ts:12\n" + "noise ".repeat(1000) } }),
    assistant("The test failed; the fix is not verified."),
  ];
}
const observations = [{ callId: "call-1", finding: "npm test failed at src/check.ts:12; no fix verified." }];
const summary = ["Goal", "Constraints", "State", "Decisions", "Next", "References"]
  .map((heading) => `## ${heading}\nRetained ${heading.toLowerCase()}.`).join("\n\n");

test("retains readable ordered blocks alongside opaque primary blocks", () => {
  const messages = conversation([event("assistant.message", { content: "", reasoningBlocks: {
    blocks: [{ type: "redacted_thinking", data: "ENCRYPTED" }],
    orderedBlocks: [{ type: "thinking", thinking: "Exact readable block.\n" }],
  } })]).messages;
  assert.deepEqual(messages[0].reasoningBlocks.blocks, [{ type: "thinking", thinking: "Exact readable block.\n" }]);
  assert(!JSON.stringify(messages).includes("ENCRYPTED"));
});

test("preserves differing readable reasoning rather than fuzzy-deleting text", () => {
  const messages = conversation([event("assistant.message", { content: "", reasoningText: "Keep every detail.",
    reasoningBlocks: { blocks: [{ type: "summary_text", text: "Keep every detail NOW." }] },
  })]).messages;
  assert.equal(messages[0].reasoningText, "Keep every detail.");
  assert.equal(messages[0].reasoningBlocks.blocks[0].text, "Keep every detail NOW.");
});

test("rejects oversized findings before they can become permanent narrative", () => {
  assert.throws(() => replaceObservations(conversation(fixture()).messages,
    [{ callId: "call-1", finding: "x".repeat(12001) }]), /12000 characters/);
});

test("pages large recorded results without retaining a joined results buffer", () => {
  const events = [1, 2].map((number) => event("tool.execution_complete", {
    toolCallId: `large-${number}`, success: true, result: { detailedContent: String(number).repeat(2 * 1024 * 1024) },
  }));
  const first = searchHistory(events, { callId: "large-1", limit: 100 });
  assert.equal(first.content.length, 100);
  assert.equal(first.matches, 1);
  const next = searchHistory(events, { callId: "large-1", limit: 100, offset: first.nextOffset, beforeEventId: first.beforeEventId });
  const full = JSON.stringify({ eventId: events[0].id, type: events[0].type, callId: "large-1", content: events[0].data.result.detailedContent });
  assert.equal(first.content + next.content, full.slice(0, 200));
  const broad = searchHistory(events, { query: "1111", limit: 100 });
  assert.equal(broad.content.length, 100);
  assert(broad.matches > 1000);
});

test("history can find attachment metadata without implying binary recovery", () => {
  const page = searchHistory([event("user.message", { content: "Inspect this.",
    attachments: [{ type: "file", path: "/fixture/unusual-image.png" }],
  })], { query: "unusual-image" });
  assert.equal(page.matches, 1);
  assert(page.content.includes("unusual-image"));
});

test("retains exact narrative, Unicode, tool status and association while stripping metadata", () => {
  const events = fixture();
  events.splice(2, 0, event("assistant.usage", { secretMetadata: "not-conversation" }));
  const active = conversation(events);
  assert.deepEqual(active.pending, []);
  const messages = replaceObservations(active.messages, observations);
  assert.deepEqual(messages.filter((m) => m.role === "user" || m.role === "assistant"),
    active.messages.filter((m) => m.role === "user" || m.role === "assistant"));
  assert.equal(messages[2].role, "finding");
  assert.equal(messages[2].success, false);
  const text = replacement("tools", messages, "same-session");
  assert(!text.includes("noise"));
  assert(!text.includes("secretMetadata"));
  assert(text.includes("Ελληνικά"));
  assert(text.includes("context_history") && text.includes("session_store_sql"));
  assert(text.length < JSON.stringify(events).length / 2);
});

test("manifest identifies calls without duplicating results", () => {
  const calls = manifest(conversation(fixture()).messages);
  assert.equal(calls.length, 1);
  assert.match(calls[0].operation, /npm test/);
  assert(!JSON.stringify(calls).includes("noise"));
});

for (const [label, values] of [
  ["missing", []], ["duplicate", [...observations, ...observations]],
  ["unknown", [{ callId: "other", finding: "x" }]],
  ["blank", [{ callId: "call-1", finding: " " }]],
]) {
  test(`rejects ${label} observations`, () => {
    assert.throws(() => replaceObservations(conversation(fixture()).messages, values));
  });
}

test("repeated pruning respects clear boundaries without resurrecting old output or wrapping transcripts", () => {
  const events = fixture();
  const retained = replaceObservations(conversation(events).messages, observations);
  const prompt = replacement("tools", retained, "s");
  events.push(event("session.context_cleared", { initialMessage: prompt }),
    event("user.message", { content: "", transformedContent: prompt }), user("Continue."));
  const active = conversation(events);
  assert.deepEqual(active.messages, [...retained, { role: "user", content: "Continue." }]);
  assert.equal(manifest(active.messages).length, 0);
  assert(!JSON.stringify(active).includes("noise"));
  assert.equal(replacement("tools", active.messages, "s").split("<context-prune-v1>").length, 2);
});

test("native compaction respects summary boundary and keeps events arriving during compaction", () => {
  const events = fixture();
  events.push(event("session.compaction_start", { compactionAttemptId: "attempt" }), user("A newer constraint."),
    event("session.compaction_complete", { success: true, compactionAttemptId: "attempt", summaryContent: "Native summary" }));
  assert.deepEqual(conversation(events).messages, [
    { role: "user", content: "Native summary" }, { role: "user", content: "A newer constraint." },
  ]);
});

test("failed compaction is not a replay boundary; latest clear wins", () => {
  const events = fixture();
  events.push(event("session.compaction_complete", { success: false, summaryContent: "Do not retain" }));
  assert(conversation(events).messages.some((m) => m.role === "tool"));
  events.push(event("session.context_cleared", { initialMessage: "New summary" }));
  assert.deepEqual(conversation(events).messages, [{ role: "user", content: "New summary" }]);
});

test("an apply completion crossing a clear boundary is not an unpruned observation", () => {
  const events = [
    event("tool.execution_start", { toolName: "context_apply", toolCallId: "apply" }),
    event("session.context_cleared", { initialMessage: "Retained state" }),
    event("tool.execution_complete", { toolCallId: "apply", success: true, result: { content: "Applied" } }),
  ];
  assert.deepEqual(conversation(events).messages, [{ role: "user", content: "Retained state" }]);
});

test("drop deterministically retains non-tool messages and exposed thinking byte-for-byte", () => {
  const events = fixture();
  const protectedEvents = [
    event("user.message", { content: "  Original user text\t\n", transformedContent: "<user>  Original user text\t\n</user>" }),
    event("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "Transient fragment" }, { ephemeral: true }),
    event("assistant.reasoning", { reasoningId: "r1", content: "  Final thinking text\t\n" }),
    event("assistant.message", { content: " \n", reasoningText: "Readable thinking.\nKeep this spacing.  ", phase: "analysis" }),
    event("assistant.message", { content: "", reasoningText: "Thinking without a prose reply.",
      reasoningBlocks: { provider: "fixture", blocks: [{ type: "thinking", thinking: "Exact block text.\n" }] },
      citations: { sources: [], spans: [] } }),
  ];
  events.push(...protectedEvents);
  const original = conversation(events).messages;
  const before = JSON.stringify(original);
  const protectedMessages = original.filter((message) => message.role !== "tool");
  const first = replaceObservations(original, observations);
  const second = replaceObservations(original, observations);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(first.filter((message) => message.role !== "finding"), protectedMessages);
  for (const message of protectedMessages) assert(first.includes(message));
  assert(!JSON.stringify(first).includes("Transient fragment"));
  const prompt = replacement("tools", first, "s");
  const again = conversation([...events, event("session.context_cleared", { initialMessage: prompt })]).messages;
  assert.deepEqual(again, first);
  assert.deepEqual(again.slice(-4), [
    { role: "user", content: "  Original user text\t\n", transformedContent: "<user>  Original user text\t\n</user>" },
    { role: "reasoning", content: "  Final thinking text\t\n" },
    { role: "assistant", content: " \n", reasoningText: "Readable thinking.\nKeep this spacing.  ", phase: "analysis" },
    { role: "assistant", content: "", reasoningText: "Thinking without a prose reply.",
      reasoningBlocks: { blocks: [{ type: "thinking", thinking: "Exact block text.\n" }] },
      citations: { sources: [], spans: [] } },
  ]);
});

test("retains readable thinking but never serializes opaque native reasoning or duplicate summaries", () => {
  const text = "Exact readable thought.\nKeep whitespace.  ";
  const events = [event("assistant.message", {
    content: "", reasoningText: text, encryptedContent: "opaque-response",
    reasoningBlocks: { provider: "openai-responses", blocks: [{
      type: "reasoning", id: "native-response-id", encrypted_content: "cipher".repeat(2000),
      summary: [{ type: "summary_text", text }], content: [],
    }] },
  })];
  assert.deepEqual(conversation(events).messages, [{ role: "assistant", content: "", reasoningText: text }]);
  const serialized = replacement("tools", conversation(events).messages, "s");
  assert(!serialized.includes("cipher") && !serialized.includes("native-response-id") && !serialized.includes("opaque-response"));
  const fallback = conversation([event("assistant.message", { content: "", reasoningBlocks: {
    provider: "anthropic", blocks: [{ type: "thinking", thinking: text, signature: "opaque-signature" }],
  } })]).messages[0];
  assert.deepEqual(fallback.reasoningBlocks, { blocks: [{ type: "thinking", thinking: text }] });
  assert(!JSON.stringify(fallback).includes("opaque-signature"));
});

test("detects unresolved tools and attachments; excludes subagent events", () => {
  const events = [user("x"), event("user.message", { content: "image", attachments: [{ type: "image" }] }),
    assistant("", [{ toolCallId: "unfinished", name: "bash" }]), user("parent")];
  events.push(event("assistant.message", { content: "agent-private" }, { agentId: "child" }));
  const active = conversation(events);
  assert.equal(active.pending.length, 1);
  assert.equal(active.hasAttachments, true);
  assert(!JSON.stringify(active).includes("agent-private"));
});

test("history recovers original large tool output, including after pruning", () => {
  const events = fixture();
  events.push(event("session.context_cleared", { initialMessage: "Short summary" }));
  let offset = 0;
  let beforeEventId;
  let restored = "";
  do {
    const page = searchHistory(events, { callId: "call-1", offset, limit: 400, beforeEventId });
    assert(page.content.length <= 400);
    restored += page.content;
    offset = page.nextOffset;
    beforeEventId = page.beforeEventId;
  } while (offset !== null);
  assert.equal(JSON.parse(restored).content, conversation(fixture()).messages[2].content);
});

test("keeps native truncation markers and artifact references; bounds manifest arguments", () => {
  const events = fixture();
  events[2].data.arguments = { patch: "x".repeat(50000) };
  events[3].data.result = { content: "preview", detailedContent: "Head\n[Truncated - full output temporarily saved to /tmp/native-output.txt]" };
  const active = conversation(events);
  assert.equal(manifest(active.messages)[0].operation.length, 500);
  assert(searchHistory(events, { callId: "call-1" }).content.includes("/tmp/native-output.txt"));
  assert(searchHistory(events, { callId: "call-1" }).notice.includes("missing artifacts cannot be recovered"));
});

test("query gives a snippet around a late match rather than the start of a large log", () => {
  const events = [event("tool.execution_complete", { toolCallId: "large", success: true,
    result: { content: "x".repeat(100000) + "NEEDLE actual result" } })];
  const result = searchHistory(events, { query: "needle" });
  assert.equal(result.matches, 1);
  assert(result.content.includes("NEEDLE actual result"));
  assert.equal(searchHistory(events, { query: "absent" }).matches, 0);
  for (const input of [{}, { query: "x", limit: 12001 }, { query: "x", offset: -1 }]) {
    assert.throws(() => searchHistory(events, input));
  }
});

test("summary schema requires working-state sections", () => {
  assert.equal(validateSummary(summary), summary);
  assert.throws(() => validateSummary(""));
  assert.throws(() => validateSummary("short but missing obligations"));
});

test("staleness rejects user input, tool work, subagent work and other replacements", () => {
  const original = fixture();
  const operation = { cutoff: original.at(-1).id, prompt: "authorized operation" };
  assert.doesNotThrow(() => assertUnchanged([...original, user(operation.prompt), assistant("Preparing")], operation));
  for (const next of [
    user("new obligation"), event("tool.execution_start", { toolName: "bash", toolCallId: "new" }),
    event("tool.execution_complete", { toolCallId: "unknown" }),
    event("session.context_cleared"), event("session.compaction_start"), event("session.compaction_complete", { success: true }),
    event("assistant.message", { content: "child" }, { agentId: "child" }),
  ]) assert.throws(() => assertUnchanged([...original, next], operation));
  assert.throws(() => assertUnchanged([], operation));
});

function harness() {
  const events = fixture();
  const checkpoints = new Map();
  const calls = [];
  let queue = { items: [], steeringMessages: [] };
  let pending = { items: [] };
  let tasks = { tasks: [] };
  let failClear = false;
  let failSave = false;
  let corruptCheckpoint = false;
  let processing = false;
  let permissionItems = [];
  let failLog = false;
  let sentPrompt;
  const session = {
    sessionId: "disposable-session",
    getEvents: async () => structuredClone(events),
    send: async ({ prompt }) => {
      sentPrompt = prompt;
      events.push(user(prompt));
      calls.push("send");
    },
    rpc: {
      queue: { pendingItems: async () => queue },
      tools: { listPendingRequests: async () => pending },
      tasks: { list: async () => tasks },
      permissions: { pendingRequests: async () => ({ items: permissionItems }) },
      metadata: { isProcessing: async () => ({ processing }) },
      workspaces: {
        addSummary: async ({ content }) => {
          if (failSave) throw new Error("save failed");
          const number = checkpoints.size;
          checkpoints.set(number, content);
          calls.push("checkpoint");
          return { summary: { checkpointNumber: number } };
        },
        readCheckpoint: async ({ number }) => ({ content: corruptCheckpoint ? "corrupted" : checkpoints.get(number) }),
      },
      history: { clearContext: async ({ prompt }) => {
        calls.push("clear");
        if (failClear) throw new Error("connection lost");
        events.push(event("session.context_cleared", { initialMessage: prompt }));
        return { messagesCleared: 8 };
      } },
      log: async () => {
        if (failLog) throw new Error("logging disconnected");
        calls.push("log");
      },
    },
  };
  const extension = createContextPrune(() => session);
  const invoke = async (mode = "tools", args = "") => {
    await extension.commands.find((c) => c.name === (mode === "tools" ? "context-drop-tools" : "context-compact"))
      .handler({ sessionId: session.sessionId, args });
    return { operationId: sentPrompt.match(/operationId "([^"]+)"/)[1], mode,
      ...(mode === "tools" ? { observations } : { summary }) };
  };
  const apply = (args, sessionId = session.sessionId, invocation = {}) =>
    extension.tools.find((t) => t.name === "context_apply").handler(args, { sessionId, ...invocation });
  return {
    events, checkpoints, calls, extension, invoke, apply, prompt: () => sentPrompt,
    queue: (value) => { queue = value; }, tasks: (value) => { tasks = value; },
    pending: (value) => { pending = value; }, failClear: () => { failClear = true; },
    failSave: () => { failSave = true; }, corruptCheckpoint: () => { corruptCheckpoint = true; },
    processing: (value) => { processing = value; }, permissions: (items) => { permissionItems = items; },
    failLog: () => { failLog = true; },
  };
}

for (const mode of ["tools", "compact"]) {
  test(`${mode} command authorizes exactly one apply, saves exact checkpoint first, requires same-session reload`, async () => {
    const h = harness();
    const args = await h.invoke(mode);
    const response = await h.apply(args);
    assert.match(response, /copilot --resume disposable-session/);
    assert.deepEqual(h.calls, ["send", "checkpoint", "clear", "log"]);
    assert.equal(h.checkpoints.get(0), h.events.at(-1).data.initialMessage);
    await assert.rejects(h.apply(args), /No matching/);
    await assert.rejects(h.invoke(), /Reload this session first/);
  });
}

test("uncommanded, wrong-mode, wrong-session and canceled apply are rejected", async () => {
  const h = harness();
  await assert.rejects(h.apply({ operationId: "guessed", mode: "compact", summary }), /No matching/);
  const args = await h.invoke();
  await assert.rejects(h.apply({ ...args, mode: "compact" }), /No matching/);
  await assert.rejects(h.apply(args, "another-session"), /Session scope/);
  await h.extension.commands.find((c) => c.name === "context-cancel").handler();
  await assert.rejects(h.apply(args), /No matching/);
  assert(!h.calls.includes("clear"));
});

test("new input between prepare and apply prevents clearing", async () => {
  const h = harness();
  const args = await h.invoke();
  h.events.push(user("Don't lose this."));
  await assert.rejects(h.apply(args), /new user message/);
  assert(!h.calls.includes("clear"));
  await h.invoke();
});

for (const [name, block] of [
  ["queue", (h) => h.queue({ items: [{ id: "message" }], steeringMessages: [] })],
  ["steering", (h) => h.queue({ items: [], steeringMessages: ["new message"] })],
  ["pending tools", (h) => h.pending({ items: [{ toolName: "bash" }] })],
  ["background work", (h) => h.tasks({ tasks: [{ status: "running" }] })],
  ["permission requests", (h) => h.permissions([{ requestId: "permission" }])],
]) {
  test(`blocks ${name} before preparation and before application`, async () => {
    const before = harness();
    block(before);
    await assert.rejects(before.invoke());
    const after = harness();
    const args = await after.invoke();
    block(after);
    await assert.rejects(after.apply(args));
    assert(!after.calls.includes("clear"));
  });
}

test("allows the apply request itself but not simultaneous new work", async () => {
  const h = harness();
  const args = await h.invoke();
  h.pending({ items: [{ toolName: "context_apply" }] });
  h.events.push(event("tool.execution_start", { toolName: "context_apply", toolCallId: "apply" }));
  await h.apply(args);
});

test("checkpoint save or exactness failures never clear", async () => {
  for (const failure of ["failSave", "corruptCheckpoint"]) {
    const h = harness();
    const args = await h.invoke();
    h[failure]();
    await assert.rejects(h.apply(args), /not cleared/);
    assert(!h.calls.includes("clear"));
  }
});

test("clear failure is explicit and cannot be blindly retried", async () => {
  const h = harness();
  const args = await h.invoke();
  h.failClear();
  await assert.rejects(h.apply(args), /clearing was attempted.*do not retry/);
  await assert.rejects(h.apply(args), /No matching/);
  assert.equal(h.checkpoints.size, 1);
});

test("invalid findings can be corrected without creating a checkpoint or clearing", async () => {
  const h = harness();
  const args = await h.invoke();
  await assert.rejects(h.apply({ ...args, observations: [] }), /not cleared/);
  assert.equal(h.checkpoints.size, 0);
  await h.apply(args);
});

test("drop uses only tool-finding instructions; compaction alone receives the compaction skill", async () => {
  const drop = harness();
  const args = await drop.invoke();
  assert.match(drop.prompt(), /NOT conversation compaction/);
  assert.doesNotMatch(drop.prompt(), /## Goal|# Context compaction/);
  await assert.rejects(drop.apply({ ...args, summary }), /findings, not a conversation summary/);
  assert(!drop.calls.includes("clear"));
  const compact = harness();
  const compactArgs = await compact.invoke("compact");
  assert.match(compact.prompt(), /# Context compaction/);
  await assert.rejects(compact.apply({ ...compactArgs, observations }), /summary, not tool findings/);
  assert(!compact.calls.includes("clear"));
});

test("tool mode rejects attachments, empty histories and already-pruned contexts", async () => {
  const attachment = harness();
  attachment.events.push(event("user.message", { content: "photo", attachments: [{ type: "image" }] }));
  await assert.rejects(attachment.invoke(), /attachments/);
  const empty = harness();
  empty.events.length = 0;
  await assert.rejects(empty.invoke(), /No conversation/);
  const pruned = harness();
  pruned.events.push(event("session.context_cleared", { initialMessage: "No tool output here." }));
  await assert.rejects(pruned.invoke(), /No unpruned/);
});

test("rejects preparation during native compaction", async () => {
  const h = harness();
  h.events.push(event("session.compaction_start"));
  await assert.rejects(h.invoke(), /compaction is in progress/);
});

test("rejects preparation while the agent is responding", async () => {
  const h = harness();
  h.events.push(event("assistant.turn_start"));
  await assert.rejects(h.invoke(), /agent is still responding/);
});

test("successful but unapplied native summaries are not replay boundaries", () => {
  const events = fixture();
  events.push(event("session.compaction_complete", { success: true, outcome: "skipped", summaryContent: "Not applied" }));
  assert(conversation(events).messages.some((message) => message.role === "tool"));
});

test("both context tools are never deferred and apply is terminal", () => {
  const h = harness();
  assert(h.extension.tools.every((tool) => tool.defer === "never"));
  assert.equal(h.extension.tools.find((tool) => tool.name === "context_apply").isTerminal, true);
});

test("aborted or reloaded calls no longer block preparation and never imply success", () => {
  for (const stop of ["abort", "session.resume", "session.shutdown", "session.idle", "assistant.idle"]) {
    const events = [event("assistant.turn_start"), assistant("", [{ toolCallId: "stopped", name: "bash", arguments: {} }]), event(stop)];
    const active = conversation(events);
    assert.equal(active.turnActive, false);
    assert.equal(active.pending.length, 0);
    assert.equal(active.messages.at(-1).success, false);
    assert.match(active.messages.at(-1).content, /status is unknown/);
  }
});

test("a real result arriving after abort replaces unknown status rather than duplicating the call", () => {
  const events = [assistant("", [{ toolCallId: "late", name: "bash" }]), event("abort"),
    event("tool.execution_complete", { toolCallId: "late", success: true, result: { content: "completed late" } })];
  assert.equal(conversation(events).messages.filter((message) => message.role === "tool").length, 1);
  assert.equal(conversation(events).messages.at(-1).content, "completed late");
});

test("structured results, empty-content errors and shell spill references remain recoverable", () => {
  assert.match(resultText({ result: { content: "" }, error: { message: "ENOENT" }, success: false }), /ENOENT/);
  assert.match(resultText({ result: { content: "partial" }, error: { message: "failure" } }), /failure/);
  assert.match(resultText({ result: { content: "", structuredContent: { items: [1, 2] } } }), /"items":\[1,2\]/);
  const shell = { type: "shell_exit", exitCode: 1, shellId: "shell", outputFilePath: "/tmp/spill.log", outputPreview: "last error" };
  assert.match(resultText({ result: { content: "", contents: [shell] } }), /\/tmp\/spill.log/);
  assert.match(resultText({ result: { contents: [{ type: "resource", resource: { text: "resource evidence" } }] } }), /resource evidence/);
});

test("tool-returned binary results are refused by tool-only preparation", async () => {
  for (const result of [
    { content: "image", binaryResultsForLlm: [{ type: "image", mimeType: "image/png", data: "binary" }] },
    { content: "", contents: [{ type: "audio", data: "binary" }] },
    { content: "", contents: [{ type: "resource", resource: { blob: "binary" } }] },
  ]) {
    const h = harness();
    h.events[3].data.result = result;
    await assert.rejects(h.invoke(), /attachments/);
  }
});

test("compact-to-drop envelopes exclude previous control footers and acknowledgments", () => {
  const prompt = replacement("compact", summary, "s");
  for (const seed of [
    { content: prompt },
    { content: "", transformedContent: `<wrapped>${prompt}</wrapped>` },
  ]) {
    const events = [event("session.context_cleared", { initialMessage: prompt }), event("user.message", seed),
      assistant("Context saved. Exit Copilot, then run: copilot --resume s"), user("Continue")];
    assert.deepEqual(conversation(events).messages, [{ role: "user", content: summary }, { role: "user", content: "Continue" }]);
  }
});

test("legacy compact footers are not embedded in a new transcript", () => {
  const prompt = `# Retained working context\n\n${summary}\n\nContinue the same session from this retained context. Old footer.`;
  assert.deepEqual(conversation([event("session.context_cleared", { initialMessage: prompt })]).messages,
    [{ role: "user", content: summary }]);
});

test("native compaction cannot pair a consumed start or cross a later clear boundary", () => {
  const events = [
    event("session.compaction_start"), event("session.compaction_complete", { success: false }),
    user("obsolete"), event("session.context_cleared", { initialMessage: "Retained" }),
    user("new information"), event("session.compaction_complete", { success: true, summaryContent: "New native summary" }),
  ];
  assert.deepEqual(conversation(events).messages, [{ role: "user", content: "New native summary" }]);
});

test("notifications are preserved and new notifications, rewinds and parallel requests invalidate apply", () => {
  const notification = event("system.notification", { content: "Background verification completed." });
  assert.deepEqual(conversation([notification]).messages, [{ role: "notification", content: notification.data.content }]);
  const events = fixture();
  const operation = { cutoff: events.at(-1).id, prompt: "operation" };
  for (const added of [
    notification, event("session.truncation"), event("session.snapshot_rewind"),
    assistant("", [{ toolCallId: "parallel", name: "bash" }]),
  ]) assert.throws(() => assertUnchanged([...events, added], operation));
  assert.throws(() => assertUnchanged([...events, user("operation"), user("operation")], operation));
  assert.doesNotThrow(() => assertUnchanged([...events,
    event("tool.execution_start", { toolName: "tool_search_tool", toolCallId: "discovery" }),
    event("tool.execution_complete", { toolCallId: "discovery", success: true })], operation));
});

test("idle preparation expires old authorization; processing and withdrawn user input block new preparation", async () => {
  const h = harness();
  const stale = await h.invoke();
  await h.invoke();
  await assert.rejects(h.apply(stale), /No matching/);
  const processing = harness();
  processing.processing(true);
  await assert.rejects(processing.invoke(), /still processing/);
  const queued = harness();
  queued.queue({ items: [], steeringMessages: [], withdrawableTurnMessageId: "starting-user-turn" });
  await assert.rejects(queued.invoke(), /Queued input/);
});

test("subagents, parallel apply requests and a different external request cannot apply", async () => {
  const h = harness();
  const args = await h.invoke();
  await assert.rejects(h.apply(args, "disposable-session", { agentId: "child" }), /main agent/);
  h.pending({ items: [{ toolName: "context_apply", requestId: "other" }] });
  await assert.rejects(h.apply(args, "disposable-session", { requestId: "self" }), /Other tool requests/);
  h.pending({ items: [{ toolName: "context_apply" }, { toolName: "context_apply" }] });
  await assert.rejects(h.apply(args), /Other tool requests/);
  assert(!h.calls.includes("clear"));
});

test("summary skeletons, duplicate sections and logging failures are explicit", async () => {
  assert.throws(() => validateSummary(["Goal", "Constraints", "State", "Decisions", "Next", "References"].map((h) => `## ${h}`).join("\n")));
  assert.throws(() => validateSummary(`${summary}\n## Goal\nDuplicate.`));
  const h = harness();
  h.queue({ items: [{}], steeringMessages: [] });
  h.failLog();
  await assert.rejects(h.invoke(), (error) => error instanceof AggregateError && error.errors.length === 2 && /Queued input/.test(error.message));
});

test("history queries find distant matches, exclude their own results and paginate against a stable snapshot", () => {
  const events = [
    event("tool.execution_start", { toolCallId: "original", toolName: "bash" }),
    event("tool.execution_complete", { toolCallId: "original", success: true,
      result: { content: "NEEDLE first\n" + "x".repeat(10000) + "\nNEEDLE actual crash" } }),
  ];
  const first = searchHistory(events, { query: "needle", limit: 100 });
  assert.equal(first.matches, 2);
  const own = event("tool.execution_start", { toolCallId: "history", toolName: "context_history" });
  events.push(own, event("tool.execution_complete", { toolCallId: "history", success: true, result: { content: JSON.stringify(first) } }));
  assert.equal(searchHistory(events, { query: "needle" }).matches, 2);
  events.push(user("NEEDLE newer input"));
  const rest = searchHistory(events, { query: "needle", offset: first.nextOffset, beforeEventId: first.beforeEventId });
  assert.equal(rest.matches, 2);
  assert(rest.content.includes("actual crash"));
  assert.throws(() => searchHistory(events, { query: "needle", offset: 10 }), /beforeEventId/);
  assert.throws(() => searchHistory(events), /Provide query/);
  assert.equal(searchHistory(events, { query: "needle", callId: "   " }).matches, 3);
});
