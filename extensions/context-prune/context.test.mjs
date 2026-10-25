import test from "node:test";
import assert from "node:assert/strict";
import {
  assertUnchanged, conversation, OPERATION_PREFIX, OPERATION_SOURCE_PREFIX,
  replacement, replaceObservations, resultText, validateSummary,
} from "./context.mjs";
import { searchHistory } from "./test-support/history.mjs";

let sequence = 0;
const event = (type, data = {}, extra = {}) => ({ id: `event-${++sequence}`, type, data, ...extra });
const user = (content, extra = {}) => event("user.message", { content, ...extra });
const assistant = (content, toolRequests) => event("assistant.message", { content, toolRequests });
const observations = [{ callId: "call-1", finding: "npm test failed at src/check.ts:12; no fix verified." }];
const summary = ["Goal", "Constraints", "State", "Decisions", "Next", "References"]
  .map((heading) => `## ${heading}\nRetained ${heading.toLowerCase()}.`).join("\n\n");
function fixture() {
  return [
    user("Preserve Case; never deploy. Ελληνικά."),
    assistant("Checking the failure.", [{ toolCallId: "call-1", name: "test", arguments: { command: "npm test" } }]),
    event("tool.execution_start", { toolCallId: "call-1", toolName: "test", arguments: { command: "npm test" } }),
    event("tool.execution_complete", { toolCallId: "call-1", success: false,
      result: { content: "preview", detailedContent: "FAILED at src/check.ts:12\n" + "noise ".repeat(1000) } }),
    assistant("The test failed; the fix is not verified."),
  ];
}

test("drop retains exact narrative, Unicode and status without copying tool noise or metadata", () => {
  const events = fixture();
  events.splice(2, 0, event("assistant.usage", { metadata: "not-conversation" }));
  const active = conversation(events);
  const retained = replaceObservations(active.messages, observations);
  assert.deepEqual(active.pending, []);
  assert.deepEqual(retained.filter((message) => message.role !== "finding"), active.messages.filter((message) => message.role !== "tool"));
  assert.equal(retained[2].success, false);
  const prompt = replacement("tools", retained, "same-session");
  assert(prompt.includes("Ελληνικά") && prompt.includes("session_store_sql"));
  assert(!prompt.includes("context_history") && !prompt.includes("context_apply"));
  assert(!prompt.includes("noise") && !prompt.includes("not-conversation"));
  assert(prompt.length < JSON.stringify(events).length / 2);
});

test("finding replacement depends on call IDs, not large tool arguments", () => {
  const active = conversation(fixture()).messages;
  active[2].arguments = { patch: "x".repeat(50000) };
  const finding = replaceObservations(active, observations).find((message) => message.role === "finding");
  assert.deepEqual(finding, { role: "finding", name: "test", callId: "call-1", success: false, content: observations[0].finding });
  assert(!JSON.stringify(finding).includes("noise"));
});

test("snapshot permits exactly one correlated command-owned request and no other mutation", () => {
  const events = fixture();
  const transition = { sessionId: "session", toolCallId: "owned-call", requestId: "owned-request", toolName: "context_commit" };
  const operation = { eventIds: events.map(({ id }) => id), transition };
  const owned = event("external_tool.requested", transition);
  assert.doesNotThrow(() => assertUnchanged([...events, owned], operation));
  assert.throws(() => assertUnchanged(events, operation), /history changed/);
  assert.throws(() => assertUnchanged([...events, owned, owned], operation), /history changed/);
  for (const field of ["sessionId", "toolCallId", "requestId", "toolName", "agentId"]) {
    const foreign = { ...owned, data: { ...transition, [field]: "foreign" } };
    assert.throws(() => assertUnchanged([...events, foreign], operation), /history changed/);
  }
  assert.throws(() => assertUnchanged([...events, { ...owned, agentId: "child" }], operation), /history changed/);
  assert.throws(() => assertUnchanged([...events, owned, user("new input")], operation), /history changed/);
});

test("snapshot accepts correlated commit hooks and accounting flushes but rejects unrelated hooks", () => {
  const events = fixture();
  const transition = { sessionId: "session", toolCallId: "owned", requestId: "request", toolName: "context_commit" };
  const operation = { eventIds: events.map(({ id }) => id), transition };
  const hooks = [
    event("hook.start", { hookInvocationId: "pre", hookType: "preToolUse", input: {
      sessionId: "session", toolCalls: [{ id: "owned", name: "context_commit", args: {} }],
    } }),
    event("hook.end", { hookInvocationId: "pre", hookType: "preToolUse", success: true }),
    event("hook.start", { hookInvocationId: "permission", hookType: "permissionRequest", input: {
      sessionId: "session", toolName: "context_commit", toolInput: {},
    } }),
    event("hook.end", { hookInvocationId: "permission", hookType: "permissionRequest", success: true }),
  ];
  const request = event("external_tool.requested", transition);
  assert.doesNotThrow(() => assertUnchanged([...events, ...hooks, request], operation));
  assert.doesNotThrow(() => assertUnchanged([...events, event("session.usage_checkpoint", {})],
    { eventIds: operation.eventIds }));
  for (const mutate of [
    (copy) => { copy[0].data.input.toolCalls[0].id = "foreign"; },
    (copy) => { copy[0].data.input.toolCalls.push({ id: "other", name: "view", args: {} }); },
    (copy) => { copy[2].data.input.sessionId = "foreign"; },
    (copy) => { copy[1].data.output = { additionalContext: "new evidence" }; },
    (copy) => { copy[1].data.success = false; },
    (copy) => { copy[2].agentId = "child"; },
    (copy) => { copy.splice(1, 1); },
  ]) {
    const copy = structuredClone(hooks);
    mutate(copy);
    assert.throws(() => assertUnchanged([...events, ...copy, request], operation), /history changed/);
  }
  assert.throws(() => assertUnchanged([...events, ...hooks, request, user("new work")], operation), /history changed/);
});

for (const [label, values] of [
  ["missing", []], ["duplicate", [...observations, ...observations]],
  ["unknown", [{ callId: "other", finding: "x" }]], ["blank", [{ callId: "call-1", finding: " " }]],
  ["oversized", [{ callId: "call-1", finding: "x".repeat(12001) }]],
]) {
  test(`rejects ${label} findings`, () => assert.throws(() => replaceObservations(conversation(fixture()).messages, values)));
}

test("drop preserves transformed text, finalized thinking, phase and citations byte-for-byte", () => {
  const events = fixture();
  events.push(
    user("  Exact user text\t\n", { transformedContent: "<user>  Exact user text\t\n</user>" }),
    event("assistant.reasoning_delta", { deltaContent: "Transient fragment" }),
    event("assistant.reasoning", { content: "  Final thinking\t\n" }),
    event("assistant.message", { content: " \n", reasoningText: "Readable thinking.\nKeep spacing.  ", phase: "analysis", citations: [] }),
  );
  const original = conversation(events).messages;
  const protectedText = original.filter((message) => message.role !== "tool");
  const retained = replaceObservations(original, observations);
  assert.deepEqual(retained.filter((message) => message.role !== "finding"), protectedText);
  for (const message of protectedText) assert(retained.includes(message));
  assert(!JSON.stringify(retained).includes("Transient fragment"));
  const prompt = replacement("tools", retained, "s");
  assert.deepEqual(conversation([...events, event("session.context_cleared", { initialMessage: prompt })]).messages, retained);
});

test("readable blocks omit opaque transport data and exact mirrored summaries", () => {
  const text = "Exact readable thought.\nKeep spacing.  ";
  const events = [event("assistant.message", {
    content: "", reasoningText: text,
    reasoningBlocks: { blocks: [{ type: "reasoning", id: "native-id", encrypted_content: "CIPHERTEXT",
      summary: [null, { text }], content: 42 }], orderedBlocks: [{ type: "redacted_thinking", data: "CIPHERTEXT" }] },
  })];
  assert.deepEqual(conversation(events).messages, [{ role: "assistant", content: "", reasoningText: text }]);
  const distinct = conversation([event("assistant.message", { content: "", reasoningText: "first", reasoningBlocks: {
    blocks: [{ type: "redacted_thinking", data: "CIPHERTEXT" }],
    orderedBlocks: [{ type: "thinking", thinking: text, signature: "SIGNATURE" }],
  } })]).messages[0];
  assert.deepEqual(distinct.reasoningBlocks.blocks, [{ type: "thinking", thinking: text }]);
  assert(!JSON.stringify(distinct).includes("SIGNATURE") && !JSON.stringify(distinct).includes("CIPHERTEXT"));
});

test("attachment projection retains selections and provenance without copying binary bytes", () => {
  const attachments = [
    { type: "selection", displayName: "Selected requirements", filePath: "/fixture/SpecCase.ts",
      selection: { start: { line: 2, character: 1 }, end: { line: 4, character: 9 } },
      text: "  Keep CaseSensitive_V9; never deploy. Ελληνικά.\n" },
    { type: "file", displayName: "Specification", path: "/fixture/spec.pdf", assetId: "sha256:document",
      mimeType: "application/pdf", byteLength: 321, lineRange: { start: 1, end: 4 } },
    { type: "directory", displayName: "Sources", path: "/fixture/src", taggedFilesEntry: "* /fixture/src (3 items)" },
    { type: "github_reference", url: "https://github.com/example/project/issues/17", title: "Acceptance criteria" },
    { type: "extension_context", extensionId: "fixture", capturedAt: "2026-10-25T00:00:00Z",
      title: "Review notes", canvasId: "notes", instanceId: "review", payload: { requirement: "Approval required." } },
    { type: "blob", displayName: "Screenshot", mimeType: "image/png", assetId: "sha256:screenshot",
      byteLength: 99, data: "BINARY_ATTACHMENT_BYTES" },
  ];
  const events = [user("Use the attached requirements.", { attachments })];
  const original = structuredClone(events);
  const active = conversation(events);
  assert.equal(active.hasAttachments, true);
  assert.deepEqual(active.messages[0].attachments.slice(0, -1), attachments.slice(0, -1));
  const binary = active.messages[0].attachments.at(-1);
  assert.equal(binary.assetId, "sha256:screenshot");
  assert.equal(binary.displayName, "Screenshot");
  assert.equal(binary.mimeType, "image/png");
  assert.match(binary.notice, /not inspected|not available/i);
  assert.doesNotMatch(JSON.stringify(active.messages), /BINARY_ATTACHMENT_BYTES/);
  assert.deepEqual(events, original);
  assert(searchHistory(events, { query: "CaseSensitive_V9" }).matches > 0);
  const replayed = conversation([event("session.context_cleared", {
    initialMessage: replacement("tools", active.messages, "same-session"),
  })]);
  assert.equal(replayed.hasAttachments, true);
  assert.deepEqual(replayed.messages, active.messages);
});

test("binary tool evidence retains descriptions, asset IDs and resource URIs without payloads", () => {
  const data = { success: true, result: {
    content: "Captured diagnostic evidence.",
    binaryResultsForLlm: [
      { type: "image", mimeType: "image/png", description: "Error dialog", data: "INLINE_IMAGE_BYTES",
        metadata: { path: "/fixture/error.png", source: "diagnostic" } },
      { type: "image_ref", mimeType: "image/png", description: "Persisted capture",
        assetId: "sha256:capture", byteLength: 123 },
      { type: "omitted_image", mimeType: "image/png", description: "Unavailable capture",
        omittedReason: "size_limit", byteLength: 999 },
    ],
    contents: [
      { type: "image", mimeType: "image/png", data: "CONTENT_IMAGE_BYTES" },
      { type: "audio", mimeType: "audio/wav", data: "CONTENT_AUDIO_BYTES" },
      { type: "resource", resource: { uri: "fixture://capture", mimeType: "image/png", blob: "RESOURCE_BYTES" } },
      { type: "resource", resource: { uri: "fixture://requirements", text: "Require manual approval." } },
    ],
  } };
  const original = structuredClone(data);
  const text = resultText(data);
  for (const retained of ["Error dialog", "/fixture/error.png", "diagnostic", "sha256:capture",
    "Unavailable capture", "size_limit", "fixture://capture", "image/png", "audio/wav", "Require manual approval."]) {
    assert(text.includes(retained), `Missing binary provenance: ${retained}`);
  }
  assert.match(text, /not inspected|not available/i);
  assert.doesNotMatch(text, /INLINE_IMAGE_BYTES|CONTENT_IMAGE_BYTES|CONTENT_AUDIO_BYTES|RESOURCE_BYTES/);
  assert.deepEqual(data, original);
  const events = [event("tool.execution_complete", { ...data, toolCallId: "binary-call" })];
  assert.equal(conversation(events).hasAttachments, true);
  assert(searchHistory(events, { query: "sha256:capture" }).matches > 0);
  assert.equal(conversation([event("tool.execution_complete", {
    toolCallId: "empty-binary", success: true,
    result: { contents: [{ type: "resource", resource: { uri: "fixture://empty", blob: "" } }] },
  })]).hasAttachments, true);
});

test("code-owned attachment references survive repeated mixed reductions even if summaries omit them", () => {
  const refs = [{ type: "file", path: "/fixture/document.pdf", displayName: "Unread requirements",
    notice: "Reread before relying on contents." }];
  const events = fixture();
  for (const mode of ["tools", "compact", "compact", "tools"]) {
    const messages = conversation(events).messages;
    const content = mode === "compact" ? summary
      : replaceObservations(messages, messages.filter((message) => message.role === "tool")
        .map(({ callId }) => ({ callId, finding: "Known tool outcome." })));
    events.push(event("session.context_cleared", { initialMessage: replacement(mode, content, "s", refs) }));
    assert.deepEqual(conversation(events).attachments, refs);
    assert.equal(conversation(events).hasAttachments, true);
    assert.doesNotMatch(summary, /document\.pdf/);
  }
});

test("native pasted text markers become deduplicated file references without changing user messages", () => {
  const first = '<pasted_content file="/session/files/paste-123.txt" size="456 bytes" lines="12" />';
  const second = '<pasted_content lines="3" file="/session/files/paste-456.txt" size="1.5 KB"/>';
  const content = `  Read these Ελληνικά.\n${first}\n${second}\n${first}\t`;
  const events = [user(content), user(first)];
  const original = structuredClone(events);
  const active = conversation(events);
  assert.deepEqual(active.messages, [{ role: "user", content }, { role: "user", content: first }]);
  assert.deepEqual(active.attachments, ["/session/files/paste-123.txt", "/session/files/paste-456.txt"]
    .map((path) => ({ type: "file", path, mimeType: "text/plain" })));
  assert.equal(active.hasAttachments, true);
  assert.deepEqual(events, original);
});

test("native paste references decode path entities once and preserve literal path characters", () => {
  const paths = [
    ["/session/files/Ελληνικά &amp; &quot;quoted&quot; &apos; &#35; &#x3c;.txt", '/session/files/Ελληνικά & "quoted" \' # <.txt'],
    ["/session/files/literal&amp;quot; & unmatched.txt", "/session/files/literal&quot; & unmatched.txt"],
  ];
  const content = paths.map(([encoded]) => `<pasted_content file="${encoded}" size="0" lines="0" />`).join("\n");
  const active = conversation([user(content)]);
  assert.deepEqual(active.attachments.map(({ path }) => path), paths.map(([, decoded]) => decoded));
  assert.equal(active.messages[0].content, content);
});

test("malformed paste markers and non-user sources never become attachment references", () => {
  const valid = '<pasted_content file="/session/files/paste-123.txt" size="456" lines="12" />';
  const malformed = [
    valid.replace('file="/', 'file="'),
    valid.replace('size="456"', 'size="-1"'),
    valid.replace('size="456"', 'size="9007199254740992"'),
    valid.replace('lines="12"', 'lines="many"'),
    valid.replace('lines="12"', 'file="/other.txt"'),
    valid.replace(' lines="12"', ""),
    valid.replace(" />", ' extra="value" />'),
    valid.replace(" />", ">"),
    valid.replace("paste-123", "paste-\u0000"),
    valid.replace("paste-123", "paste-&#10;"),
    valid.replace("paste-123", "paste-&#x110000;"),
    valid.replace('file="', "file='"),
    valid.replace("paste-123", 'paste-"broken'),
  ];
  const events = [
    ...malformed.map((content) => user(content)),
    user("Visible text", { transformedContent: valid }),
    assistant(valid),
    event("assistant.reasoning", { content: valid }),
    event("system.notification", { content: valid }),
    event("user.message", { content: valid }, { agentId: "child" }),
    event("tool.execution_complete", { toolCallId: "paste-output", result: { content: valid } }),
  ];
  const active = conversation(events);
  assert.deepEqual(active.attachments, []);
  assert.equal(active.hasAttachments, false);
  assert.deepEqual(active.messages.slice(0, malformed.length).map(({ content }) => content), malformed);
});

test("native paste references survive mixed reductions and merge with an existing registry", () => {
  const path = "/session/files/paste-123.txt";
  const marker = `<pasted_content file="${path}" size="20 bytes" lines="1" />`;
  const other = { type: "file", path: "/fixture/requirements.pdf", mimeType: "application/pdf" };
  const events = [user(marker, { attachments: [other] })];
  const expected = conversation(events).attachments;
  assert.equal(expected.length, 2);
  for (const mode of ["tools", "tools", "compact", "tools", "compact"]) {
    const active = conversation(events);
    const prompt = replacement(mode, mode === "tools" ? active.messages : summary, "s", active.attachments);
    events.push(event("session.context_cleared", { initialMessage: prompt }),
      user("", { transformedContent: prompt }), user(marker));
    const replayed = conversation(events);
    assert.deepEqual(replayed.attachments, expected);
    assert.equal(replayed.hasAttachments, true);
    assert.doesNotMatch(summary, /paste-123/);
  }
  const existing = { type: "file", path, notice: "Already registered." };
  const restored = conversation([event("session.context_cleared", {
    initialMessage: replacement("tools", [{ role: "user", content: marker }], "s", [existing]),
  }), user(marker)]);
  assert.deepEqual(restored.attachments, [existing]);
  const legacyDrop = replacement("tools", [{ role: "user", content: marker }], "s");
  assert.deepEqual(conversation([event("session.context_cleared", { initialMessage: legacyDrop })]).attachments,
    [{ type: "file", path, mimeType: "text/plain" }]);
});

test("malformed saved attachment reference lists cannot silently disappear", () => {
  const prompt = replacement("compact", summary, "s", [{}]).replace('"attachmentReferences":[{}]', '"attachmentReferences":[null]');
  assert.throws(() => conversation([event("session.context_cleared", { initialMessage: prompt })]), /Invalid saved attachment references/);
});

test("repeated blocks preserve source order and multiplicity without duplicating mirrors", () => {
  const block = (thinking) => ({ type: "thinking", thinking });
  const blocks = [block("first"), block("second"), block("first")];
  const events = [event("assistant.message", { content: "", reasoningBlocks: {
    blocks, orderedBlocks: [...blocks, block("third"), block("first")],
  } })];
  const expected = [...blocks, block("third"), block("first")];
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(conversation(events).messages[0].reasoningBlocks.blocks, expected);
    events.push(event("session.context_cleared", { initialMessage: replacement("tools", conversation(events).messages, "s") }));
  }
});

test("repeated drops respect clear boundaries and do not nest transcripts", () => {
  const events = fixture();
  const retained = replaceObservations(conversation(events).messages, observations);
  const prompt = replacement("tools", retained, "s");
  events.push(event("session.context_cleared", { initialMessage: prompt }), user("", { transformedContent: prompt }), user("Continue"));
  assert.deepEqual(conversation(events).messages, [...retained, { role: "user", content: "Continue" }]);
  assert(!conversation(events).messages.some((message) => message.role === "tool"));
  assert.equal(replacement("tools", conversation(events).messages, "s").split("<context-prune-v1>").length, 2);
});

test("compact/drop replay excludes generated seeds and legacy reload acknowledgments", () => {
  const prompt = replacement("compact", summary, "s");
  for (const seed of [user(prompt), user("", { transformedContent: `<wrapped>${prompt}</wrapped>` })]) {
    assert.deepEqual(conversation([event("session.context_cleared", { initialMessage: prompt }), seed,
      assistant("Context saved. Exit Copilot, then run: copilot --resume s"), user("Continue")]).messages,
    [{ role: "user", content: summary }, { role: "user", content: "Continue" }]);
  }
  const legacy = `# Retained working context\n\n${summary}\n\nContinue the same session from this retained context. Old footer.`;
  assert.deepEqual(conversation([event("session.context_cleared", { initialMessage: legacy })]).messages, [{ role: "user", content: summary }]);
});

test("consecutive compacts replace prior summaries without nesting or losing original history", () => {
  const events = fixture();
  const original = searchHistory(events, { callId: "call-1" }).content;
  let previous;
  for (let round = 0; round < 12; round++) {
    const update = `New requirement ${round}.`;
    events.push(user(update));
    if (previous) {
      assert.deepEqual(conversation(events).messages, [
        { role: "user", content: previous }, { role: "user", content: update },
      ]);
    }
    const next = summary.replace("Retained state.", `Current state ${round}.`);
    const retained = replacement("compact", validateSummary(next), "same-session");
    events.push(event("session.context_cleared", { initialMessage: retained }),
      user("", { transformedContent: retained }), event("session.resume"));
    assert.deepEqual(conversation(events).messages, [{ role: "user", content: next }]);
    assert.equal(retained.split("<context-prune-v1>").length, 2);
    assert.equal(searchHistory(events, { callId: "call-1" }).content, original);
    previous = next;
  }
});

test("native compaction keeps concurrent messages and cannot reuse starts across a clear", () => {
  const events = fixture();
  events.push(event("session.compaction_start", { compactionAttemptId: "a" }), user("Newer constraint"),
    event("session.compaction_complete", { success: true, compactionAttemptId: "a", summaryContent: "Native summary" }));
  assert.deepEqual(conversation(events).messages, [{ role: "user", content: "Native summary" }, { role: "user", content: "Newer constraint" }]);
  events.push(event("session.context_cleared", { initialMessage: "Retained" }), user("new information"),
    event("session.compaction_complete", { success: true, summaryContent: "New native summary" }));
  assert.deepEqual(conversation(events).messages, [{ role: "user", content: "New native summary" }]);
});

test("failed and unapplied native compactions cannot remove current evidence", () => {
  for (const data of [{ success: false }, { success: true, outcome: "skipped" }]) {
    assert(conversation([...fixture(), event("session.compaction_complete", { ...data, summaryContent: "Not applied" })]).messages.some((m) => m.role === "tool"));
  }
});

test("interrupted calls have unknown outcomes; late recorded results replace placeholders", () => {
  for (const stop of ["abort", "session.resume", "session.shutdown", "session.idle", "assistant.idle"]) {
    const events = [event("assistant.turn_start"), assistant("", [{ toolCallId: "late", name: "bash" }]), event(stop)];
    const active = conversation(events);
    assert.equal(active.turnActive, false);
    assert.equal(active.pending.length, 0);
    assert.equal(active.messages.at(-1).success, false);
    assert.match(active.messages.at(-1).content, /status is unknown/);
    events.push(event("tool.execution_complete", { toolCallId: "late", success: true, result: { content: "late result" } }));
    const completed = conversation(events).messages.filter((m) => m.role === "tool");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].content, "late result");
  }
});

test("detects unresolved calls and binary evidence but excludes subagent narrative", () => {
  const events = [assistant("", [{ toolCallId: "pending", name: "bash" }]), user("photo", { attachments: [{}] }),
    event("assistant.message", { content: "child-private" }, { agentId: "child" })];
  assert.equal(conversation(events).pending.length, 1);
  assert.equal(conversation(events).hasAttachments, true);
  assert(!JSON.stringify(conversation(events)).includes("child-private"));
  for (const result of [
    { binaryResultsForLlm: [{}] }, { contents: [{ type: "audio", data: "binary" }] },
    { contents: [{ type: "resource", resource: { blob: "binary" } }] },
  ]) assert.equal(conversation([event("tool.execution_complete", { toolCallId: "binary", result })]).hasAttachments, true);
});

test("legacy extension completions crossing a clear boundary do not become tool evidence", () => {
  const events = [event("tool.execution_start", { toolName: "context_apply", toolCallId: "apply" }),
    event("session.context_cleared", { initialMessage: "Retained" }),
    event("tool.execution_complete", { toolCallId: "apply", success: true, result: { content: "Applied" } })];
  assert.deepEqual(conversation(events).messages, [{ role: "user", content: "Retained" }]);
});

test("literal operation markers remain prose; only correlated legacy origins are excluded", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const content = `${OPERATION_PREFIX}Prepare findings and immediately call context_apply once with operationId "${id}" and mode "tools".`;
  for (const source of [undefined, "user", "system", `${OPERATION_SOURCE_PREFIX}other`]) {
    const events = [user(content, { source })];
    assert.equal(conversation(events).messages[0].content, content);
    assert.equal(searchHistory(events, { query: id }).matches, 1);
  }
  const generated = user(content, { source: `${OPERATION_SOURCE_PREFIX}${id}` });
  assert.deepEqual(conversation([generated]).messages, []);
  const copied = user(content, { source: "user" });
  assert.equal(conversation([generated, copied]).messages[0].content, content);
  const legacy = user(content, { source: "system" });
  const request = event("tool.execution_start", { toolName: "context_apply", toolCallId: "apply", arguments: { operationId: id } });
  assert.deepEqual(conversation([legacy, request]).messages, []);
});

test("snapshot validation rejects any appended, rewound or substituted event", () => {
  const events = fixture();
  const snapshot = { eventIds: events.map((e) => e.id) };
  assert.doesNotThrow(() => assertUnchanged(events, snapshot));
  for (const extra of [user("new"), event("system.notification"), event("tool.execution_start"),
    event("session.compaction_start"), event("abort"), event("tool.execution_start", { toolName: "tool_search_tool" }),
    event("assistant.message", {}, { agentId: "child" })]) assert.throws(() => assertUnchanged([...events, extra], snapshot));
  assert.throws(() => assertUnchanged(events.slice(1), snapshot));
  assert.throws(() => assertUnchanged([user("replaced"), ...events.slice(1)], snapshot));
});

test("summary validation rejects skeletons, missing sections and duplicate sections", () => {
  assert.equal(validateSummary(summary), summary);
  for (const invalid of ["", "too little", summary + "\n## Goal\nDuplicate.",
    ["Goal", "Constraints", "State", "Decisions", "Next", "References"].map((heading) => `## ${heading}`).join("\n")]) {
    assert.throws(() => validateSummary(invalid));
  }
});

test("recorded errors, structured content, citations and spill references remain recoverable", () => {
  for (const result of ["partial", { content: "" }, { content: "partial" }]) {
    assert.match(resultText({ result, error: { message: "ENOENT" }, success: false }), /ENOENT/);
  }
  assert.match(resultText({ result: { structuredContent: { items: [1, 2] } } }), /"items":\[1,2\]/);
  assert.match(resultText({ result: { contents: [{ type: "shell_exit", outputFilePath: "/tmp/spill.log" }] } }), /\/tmp\/spill.log/);
  assert.match(resultText({ result: { citableSources: [{ url: "https://example.invalid" }] } }), /example.invalid/);
  assert.match(resultText({ result: { contents: [{ type: "resource", resource: { text: "evidence" } }] } }), /evidence/);
});

test("history indexes all readable fields and attachments, never opaque payloads", () => {
  const events = [user("displayed", { transformedContent: "transformed", reasoningText: "readable",
    attachments: [{ path: "/fixture/image.png" }], reasoningBlocks: {
      blocks: [{ type: "reasoning", summary: [null, { text: "block-only" }], encrypted_content: "CIPHERTEXT" }],
      orderedBlocks: [{ type: "thinking", thinking: "ordered-only", signature: "SIGNATURE" }],
    },
  })];
  for (const query of ["displayed", "transformed", "readable", "block-only", "ordered-only", "image.png"]) {
    assert.equal(searchHistory(events, { query }).matches, 1);
  }
  for (const query of ["CIPHERTEXT", "SIGNATURE"]) assert.equal(searchHistory(events, { query }).matches, 0);
});

test("recovery exposes recorded failure metadata in query and call-ID results", () => {
  const error = { code: "FAILED", message: "failed-diagnostic" };
  for (const result of ["partial-evidence", { content: "partial-evidence" }]) {
    const events = [event("tool.execution_complete", { toolCallId: "failed", success: false, error, result })];
    for (const args of [{ callId: "failed" }, { query: "partial-evidence" }, { query: "failed-diagnostic" }]) {
      const record = JSON.parse(searchHistory(events, args).content);
      assert.equal(record.success, false);
      assert.deepEqual(record.error, error);
    }
  }
  const unknown = JSON.parse(searchHistory([event("tool.execution_complete", {
    toolCallId: "unknown", result: { content: "unknown" },
  })], { callId: "unknown" }).content);
  assert(!Object.hasOwn(unknown, "success"));
});

test("history pagination reconstructs large output against a stable event snapshot", () => {
  const events = fixture();
  let offset = 0;
  let beforeEventId;
  let restored = "";
  do {
    const page = searchHistory(events, { callId: "call-1", offset, beforeEventId, limit: 400 });
    assert(page.content.length <= 400);
    restored += page.content;
    offset = page.nextOffset;
    beforeEventId = page.beforeEventId;
    events.push(user("Newer input must not shift a page"));
  } while (offset !== null);
  assert.equal(JSON.parse(restored).content, conversation(fixture()).messages[2].content);
});

test("search returns distant matches, excludes old recovery output and rejects invalid pagination", () => {
  const events = [event("tool.execution_complete", { toolCallId: "original", success: true,
    result: { content: "NEEDLE first\n" + "x".repeat(10000) + "\nNEEDLE actual crash" } })];
  const first = searchHistory(events, { query: "needle", limit: 100 });
  assert.equal(first.matches, 2);
  events.push(event("tool.execution_start", { toolCallId: "history", toolName: "context_history" }),
    event("tool.execution_complete", { toolCallId: "history", result: { content: JSON.stringify(first) } }));
  assert.equal(searchHistory(events, { query: "needle" }).matches, 2);
  const rest = searchHistory(events, { query: "needle", offset: first.nextOffset, beforeEventId: first.beforeEventId });
  assert(rest.content.includes("actual crash"));
  for (const args of [{}, { query: "x", offset: 1 }, { query: "x", limit: 12001 }, { query: "x", offset: -1 },
    { query: "x", beforeEventId: "missing" }]) assert.throws(() => searchHistory(events, args));
  assert.equal(searchHistory(events, { query: "absent" }).matches, 0);
});

test("large history pages stay bounded without retaining a joined result buffer", () => {
  const events = [1, 2].map((number) => event("tool.execution_complete", {
    toolCallId: `large-${number}`, success: true, result: { detailedContent: String(number).repeat(2 * 1024 * 1024) },
  }));
  const first = searchHistory(events, { callId: "large-1", limit: 100 });
  const next = searchHistory(events, { callId: "large-1", limit: 100, offset: first.nextOffset, beforeEventId: first.beforeEventId });
  const full = JSON.stringify({ eventId: events[0].id, type: events[0].type, callId: "large-1", success: true, content: events[0].data.result.detailedContent });
  assert.equal(first.content + next.content, full.slice(0, 200));
  assert.equal(searchHistory(events, { query: "1111", limit: 100 }).content.length, 100);
});
