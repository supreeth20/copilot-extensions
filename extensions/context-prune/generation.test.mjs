import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSdkGenerator, findCliPath } from "./generation.mjs";

function fixture() {
  const state = { calls: [], events: [], response: '{"summary":"generated"}' };
  const worker = {
    sessionId: "owned-worker",
    sendAndWait: async (request, timeout) => {
      state.calls.push("send");
      state.request = request;
      state.timeout = timeout;
      await state.wait?.();
      return { data: { content: state.response } };
    },
    getEvents: async () => state.events,
    rpc: { model: { getCurrent: async () => state.selected ?? {
      modelId: "chosen-model", providerId: "copilot", contextTier: "long_context", reasoningEffort: "high",
    } } },
    abort: async () => { state.calls.push("abort"); },
  };
  const client = {
    createSession: async (config) => { state.config = config; state.calls.push("create"); return worker; },
    deleteSession: async (id) => { assert.equal(id, worker.sessionId); state.calls.push("delete"); },
    stop: async () => { state.calls.push("stop"); return state.stopErrors ?? []; },
    forceStop: async () => { state.calls.push("force-stop"); },
  };
  const generate = createSdkGenerator((options) => { state.options = options; return client; });
  const controller = new AbortController();
  const run = () => generate({ prompt: "Synthetic evidence", responseSchema: { type: "object" }, model: "chosen-model",
    providerId: "copilot", contextTier: "long_context", reasoningEffort: "high", signal: controller.signal });
  return { state, client, worker, controller, run };
}

test("SDK worker has no tools, extensions, discovery, session store, skills or permissions", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { summary: "generated" });
  assert.equal(f.state.options.mode, "empty");
  assert.equal(f.state.config.model, "chosen-model");
  assert.equal(f.state.config.contextTier, "long_context");
  assert.equal(f.state.config.reasoningEffort, "high");
  assert.equal(f.state.config.configDirectory, undefined);
  assert.deepEqual(f.state.config.availableTools, []);
  assert.deepEqual(f.state.config.tools, []);
  for (const field of ["requestExtensions", "enableConfigDiscovery", "enableSessionStore", "enableSkills",
    "enableFileHooks", "enableHostGitOperations", "enableOnDemandInstructionDiscovery"]) assert.equal(f.state.config[field], false);
  assert.deepEqual(await f.state.config.onPermissionRequest({ kind: "shell" }), { kind: "reject" });
  assert.equal(f.state.config.infiniteSessions.enabled, false);
  assert.equal(f.state.config.systemMessage.mode, "replace");
  assert.deepEqual(f.state.calls, ["create", "send", "delete", "stop"]);
  await assert.rejects(access(dirname(f.state.options.baseDirectory)));
});

for (const bad of [
  { response: "invalid JSON" },
  { events: [{ type: "tool.execution_start", data: { toolName: "shell" } }] },
  { events: [{ type: "assistant.message", data: { toolRequests: [{ name: "context_apply" }] } }] },
]) {
  test(`invalid or action-seeking worker output is rejected and cleaned up: ${Object.keys(bad)[0]}`, async () => {
    const f = fixture();
    Object.assign(f.state, bad);
    await assert.rejects(f.run(), /SDK text generation failed/);
    assert.deepEqual(f.state.calls, ["create", "send", "abort", "delete", "stop"]);
    await assert.rejects(access(dirname(f.state.options.baseDirectory)));
  });
}

test("cancellation and timeouts stop in-flight generation and delete temporary data", async () => {
  for (const failure of ["cancel", "timeout"]) {
    const f = fixture();
    f.state.wait = async () => {
      if (failure === "cancel") {
        f.controller.abort(new Error("canceled"));
        await new Promise(() => {});
      } else throw new Error("timed out");
    };
    await assert.rejects(f.run(), /canceled|timed out/);
    assert.deepEqual(f.state.calls, ["create", "send", "abort", "delete", "stop"]);
    await assert.rejects(access(dirname(f.state.options.baseDirectory)));
  }
});

test("worker shutdown errors fail the operation rather than returning successful text", async () => {
  const f = fixture();
  f.state.stopErrors = [new Error("shutdown failed")];
  await assert.rejects(f.run(), /shutdown failed/);
  assert(f.state.calls.includes("force-stop"));
  await assert.rejects(access(dirname(f.state.options.baseDirectory)));
});

test("a canceled request never even starts a worker", async () => {
  const f = fixture();
  f.controller.abort(new Error("canceled before start"));
  await assert.rejects(f.run(), /canceled before start/);
  assert.equal(f.state.options, undefined);
});

test("model, provider, context tier and effort mismatch fail before generation, without silent fallback", async () => {
  for (const field of ["modelId", "providerId", "contextTier", "reasoningEffort"]) {
    const f = fixture();
    f.state.selected = { modelId: "chosen-model", providerId: "copilot", contextTier: "long_context", reasoningEffort: "high", [field]: "different" };
    await assert.rejects(f.run(), /cannot reproduce the active model/);
    assert(!f.state.calls.includes("send"));
    assert.deepEqual(f.state.calls, ["create", "abort", "delete", "stop"]);
  }
});

test("CLI resolution honors an explicit path, the host executable, then executable PATH entries", async () => {
  assert.equal(await findCliPath({ env: { COPILOT_CLI_PATH: "/explicit/copilot" } }), "/explicit/copilot");
  assert.equal(await findCliPath({ env: {}, execPath: "/host/copilot" }), "/host/copilot");
  const root = await mkdtemp(join(tmpdir(), "copilot-cli-resolution-"));
  try {
    const cli = join(root, process.platform === "win32" ? "copilot.exe" : "copilot");
    await mkdir(cli);
    await assert.rejects(findCliPath({ env: { PATH: root }, execPath: "/test/node" }), /executable not found/);
    await rm(cli, { recursive: true });
    await writeFile(cli, "synthetic executable fixture", { mode: 0o700 });
    assert.equal(await findCliPath({ env: { PATH: root }, execPath: "/test/node" }), cli);
    await assert.rejects(findCliPath({ env: {}, execPath: "/test/node" }), /COPILOT_CLI_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
