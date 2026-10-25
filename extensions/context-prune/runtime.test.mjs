import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversation } from "./context.mjs";
import { createContextPrune } from "./runtime.mjs";

const summary = ["Goal", "Constraints", "State", "Decisions", "Next", "References"]
  .map((heading) => `## ${heading}\nRetained ${heading.toLowerCase()}.`).join("\n\n");
let sequence = 0;
const event = (type, data = {}, extra = {}) => ({ id: `runtime-${++sequence}`, type, data, ...extra });
function harness(workspace, options = {}) {
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
      commands: { enqueue: async (request) => {
        state.calls.push("restart");
        state.restartRequest = request;
        await state.hooks.restart?.();
        if (state.failRestart) throw new Error("restart connection failed");
        return { queued: state.restartAccepted !== false };
      } },
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
        getWorkspace: async () => ({ path: workspace, workspace: { cwd: "/fixture" } }),
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
      log: async ({ message, ephemeral }) => {
        if (state.failLog) throw new Error("logging failed");
        if (ephemeral) {
          (state.progress ??= []).push(message);
          return;
        }
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
  const extension = createContextPrune(() => session, { generate, ...options });
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
    assert.equal(h.state.progress.length, 4);
    assert.match(h.state.progress[0], /Starting/);
    assert.match(h.state.progress.at(-1), /applying context replacement/);
    await assert.rejects(h.invoke(), /Reload this session first/);
  });
}

for (const mode of ["tools", "compact"]) {
  test(`${mode} requests native restart only after a verified clear and revoked authorization`, async () => {
    const h = harness(undefined, { restartAfterReduction: true });
    h.state.hooks.restart = async () => {
      assert.match(h.state.lastLog, /Requesting native \/restart/);
      await assert.rejects(h.extension.tools[0].handler({}, h.state.invocation), /Only the command/);
      await assert.rejects(h.invoke(), /Reload this session first/);
    };
    await h.invoke(mode);
    assert.deepEqual(h.state.restartRequest, { command: "/restart" });
    assert.equal(h.state.calls.filter((call) => call === "restart").length, 1);
    assert(h.state.calls.indexOf("restart") > h.state.calls.indexOf("clear"));
    assert(h.state.calls.indexOf("restart") > h.state.calls.indexOf("log"));
  });
}

test("failed, cancelled and ambiguous reductions never request restart", async () => {
  for (const failure of ["failGeneration", "failSave", "corrupt", "failExecute", "failClear", "cancel"]) {
    const h = harness(undefined, { restartAfterReduction: true });
    if (failure === "cancel") h.state.hooks.generate = () => h.cancel();
    else h.state[failure] = true;
    await assert.rejects(h.invoke());
    assert(!h.state.calls.includes("restart"));
  }
});

test("unsupported or failed automatic restart reports applied context and manual recovery, never retries", async () => {
  for (const failure of ["unsupported", "connection"]) {
    const h = harness(undefined, { restartAfterReduction: true });
    if (failure === "unsupported") h.state.restartAccepted = false;
    else h.state.failRestart = true;
    await assert.rejects(h.invoke(), /replacement was applied.*automatic restart failed.*Do not repeat.*copilot --resume same-session/);
    await assert.rejects(h.invoke(), /Reload this session first/);
    assert.equal(h.state.calls.filter((call) => call === "clear").length, 1);
    assert.equal(h.state.calls.filter((call) => call === "restart").length, 1);
  }
});

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

for (const mode of ["tools", "compact"]) {
test(`${mode} preserves attachment paths independently of model prose and saves pasted bytes`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(root);
  const selection = { type: "selection", displayName: "Review requirements", filePath: "/fixture/ReviewCase.ts",
    selection: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
    text: "Never deploy. Require REVIEW_ATTACHMENT_9 approval." };
  h.state.events[0].data.attachments = [
    selection,
    { type: "blob", displayName: "Review diagram", mimeType: "image/png", assetId: "sha256:review",
      data: Buffer.from("ATTACHMENT_BINARY_BYTES").toString("base64") },
  ];
  h.state.events[2].data.result.binaryResultsForLlm = [
    { type: "image_ref", assetId: "sha256:tool-capture", mimeType: "image/png", byteLength: 10,
      description: "Unverified diagnostic capture", metadata: { path: "/fixture/capture.png" } },
  ];
  const original = structuredClone(h.state.events);
  await h.invoke(mode);
  const request = h.state.requests[0];
  const payload = JSON.parse(request.prompt.split("\n\n").at(-1));
  if (mode === "compact") {
    assert.deepEqual(payload.messages[0].attachments[0], selection);
    assert.equal(payload.messages[0].attachments[1].assetId, "sha256:review");
    assert.equal(payload.attachmentReferences.length, 3);
  } else {
    assert.doesNotMatch(request.prompt, /Review requirements|sha256:review/);
  }
  for (const evidence of ["sha256:tool-capture", "Unverified diagnostic capture", "/fixture/capture.png"]) {
    assert(request.prompt.includes(evidence));
  }
  assert.match(request.prompt, /not inspected|not available/i);
  if (mode === "compact") assert.match(request.prompt, /attachment/i);
  assert.doesNotMatch(request.prompt, /ATTACHMENT_BINARY_BYTES/);
  assert.deepEqual(h.state.events.slice(0, original.length), original);
  const restored = conversation(h.state.events);
  assert.equal(restored.attachments.length, 3);
  assert.equal(restored.attachments[0].path, selection.filePath);
  assert.equal(await readFile(restored.attachments[1].path, "utf8"), "ATTACHMENT_BINARY_BYTES");
  assert.equal(restored.attachments[2].path, "/fixture/capture.png");
  assert.match(h.state.checkpoints.get(0), /reread each referenced path/);
});
}

test("missing attachment bytes are disclosed, not silently dropped or fabricated", async () => {
  const h = harness();
  h.state.events[0].data.attachments = [{ type: "blob", assetId: "missing", mimeType: "image/png" }];
  await h.invoke();
  assert.equal(conversation(h.state.events).attachments[0].unavailable, true);
  assert.match(h.state.lastLog, /attachmentRecoveryGaps=1/);
});

test("attachment persistence failure prevents generation, checkpointing and clearing", async () => {
  const h = harness();
  h.state.events[0].data.attachments = [{ type: "blob", data: "cGRm" }];
  await assert.rejects(h.invoke(), /local session workspace/);
  assert(!h.state.calls.includes("generate") && !h.state.calls.includes("checkpoint") && !h.state.calls.includes("clear"));
});

for (const mimeType of ["application/pdf", "text/plain"]) {
  test(`replayed saved ${mimeType} corruption blocks clear and deletion reports missing evidence`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "context-saved-replay-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const initial = harness(root);
    initial.state.events[0].data.attachments = [{
      type: "blob", mimeType, data: Buffer.from("original").toString("base64"),
    }];
    await initial.invoke("compact");
    const [ref] = conversation(initial.state.events).attachments;
    await writeFile(ref.path, "modified");
    const corrupted = harness(root);
    corrupted.state.events = structuredClone(initial.state.events);
    await assert.rejects(corrupted.invoke("compact"), /Context was not cleared.*do not match/);
    for (const call of ["generate", "checkpoint", "clear"]) assert(!corrupted.state.calls.includes(call));
    await rm(ref.path);
    const missing = harness(root);
    missing.state.events = structuredClone(initial.state.events);
    await missing.invoke("compact");
    assert.equal(conversation(missing.state.events).attachments[0].unavailable, true);
    assert.match(missing.state.lastLog, /attachmentRecoveryGaps=1/);
  });
}

for (const firstMode of ["tools", "compact"]) {
  test(`${firstMode} protects native pasted paths and deleted clipboard images through repeated reductions`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "context-native-references-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pastePath = join(root, "files", "paste-123.txt");
    const missingTemporaryImage = join(root, "already-removed-clipboard.png");
    const imageBytes = Buffer.from("RECORDED_NATIVE_IMAGE_BYTES");
    let events = harness(root).state.events;
    events[0].data.content = `Original user prose.\n<pasted_content file="${pastePath}" size="20 bytes" lines="1" />`;
    events[0].data.attachments = [{
      type: "file", displayName: "Clipboard.png", path: missingTemporaryImage,
      mimeType: "image/png", assetId: "native-clipboard",
    }];
    events.unshift(event("session.binary_asset", {
      assetId: "native-clipboard", mimeType: "image/png", data: imageBytes.toString("base64"),
    }));
    let durableImagePath;
    for (const mode of [firstMode, "compact", "compact", "tools", "compact"]) {
      const h = harness(root);
      h.state.events = structuredClone(events);
      if (mode === "tools" && events.some((entry) => entry.type === "session.context_cleared")) {
        h.state.events.push(...harness(root).state.events.slice(1));
      }
      await h.invoke(mode);
      const active = conversation(h.state.events);
      const pasted = active.attachments.filter((reference) => reference.path === pastePath);
      assert.equal(pasted.length, 1, "Native marker path survives in exactly one code-owned reference");
      const images = active.attachments.filter((reference) => reference.displayName === "Clipboard.png");
      assert.equal(images.length, 1);
      assert.notEqual(images[0].path, missingTemporaryImage);
      assert.deepEqual(await readFile(images[0].path), imageBytes);
      durableImagePath ??= images[0].path;
      assert.equal(images[0].path, durableImagePath);
      if (mode === "compact") {
        assert.equal(active.messages[0].content, summary, "Generated summary intentionally contains no paths");
        const payload = JSON.parse(h.state.requests[0].prompt.split("\n\n").at(-1));
        assert(payload.attachmentReferences.some((reference) => reference.path === pastePath));
      } else {
        assert(!h.state.requests[0].prompt.includes(pastePath), "Tool-only worker never rewrites pasted references");
      }
      events = h.state.events;
    }
  });
}

test("invalid recorded clipboard bytes cannot fall back to a temporary path and clear", async () => {
  const h = harness();
  h.state.events[0].data.attachments = [{
    type: "file", path: "/temporary/clipboard.png", mimeType: "image/png", assetId: "bad-image",
  }];
  h.state.events.unshift(event("session.binary_asset", {
    assetId: "bad-image", mimeType: "image/png", data: "not base64!",
  }));
  await assert.rejects(h.invoke("compact"), /valid base64/);
  assert(!h.state.calls.includes("generate") && !h.state.calls.includes("checkpoint") && !h.state.calls.includes("clear"));
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
  ...["running", "orphaned"].map((status) => ["tasks", { tasks: [{ type: "agent", status }] }]),
  ["tasks", { tasks: [{ type: "client", status: "idle" }] }],
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

for (const mode of ["tools", "compact"]) {
  test(`${mode} allows idle subagents without cancelling or removing them`, async () => {
    const h = harness();
    const tasks = [{ type: "agent", id: "reviewer", status: "idle", result: "Review finished." }];
    h.state.tasks.tasks = structuredClone(tasks);
    await h.invoke(mode);
    assert(h.state.calls.includes("clear"));
    assert.deepEqual(h.state.tasks.tasks, tasks);
  });
}

for (const phase of ["generate", "read", "execute"]) {
  test(`idle subagent resuming during ${phase} prevents clearing`, async () => {
    const h = harness();
    const task = { type: "agent", id: "reviewer", status: "idle" };
    h.state.tasks.tasks = [task];
    h.state.hooks[phase] = async () => { task.status = "running"; };
    await assert.rejects(h.invoke("compact"), /Background work is active/);
    assert(!h.state.calls.includes("clear"));
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

test("preconditions reject empty, tool-free and actively compacting histories", async () => {
  for (const [mutate, expected] of [
    [(state) => { state.events = []; }, /No conversation/],
    [(state) => { state.events = state.events.slice(0, 1); }, /No unpruned/],
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
