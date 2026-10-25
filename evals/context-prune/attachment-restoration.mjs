import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

if (!process.env.COPILOT_EVAL_SDK || !process.env.COPILOT_EVAL_CLI) {
  throw new Error("Set COPILOT_EVAL_SDK and COPILOT_EVAL_CLI.");
}
const { CopilotClient, RuntimeConnection } =
  await import(pathToFileURL(resolve(process.env.COPILOT_EVAL_SDK)).href);
const realModel = process.argv.includes("--real-model");
const fileDocument = process.argv.includes("--pdf-file");
const documentEvaluation = process.argv.includes("--pdf") || fileDocument;
const root = resolve("evals/context-prune/.runs", randomUUID());
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const extensionDirectory = join(root, "home", "extensions", "attachment-probe");
await mkdir(extensionDirectory, { recursive: true });
await copyFile(new URL("./fixtures/attachment-probe/extension.mjs", import.meta.url), join(extensionDirectory, "extension.mjs"));
const observations = [];
const requests = [];
const checks = [];
const pushed = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let phase = "initial";
let client;
let session;
let sessionId;
let stopped = false;
let server;
let baseUrl;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png() {
  const size = 512;
  const chunk = (kind, data) => {
    const type = Buffer.from(kind);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = x < size / 2 ? 255 : 0;
      row[2 + x * 3] = y < size / 2 ? 0 : 255;
      row[3 + x * 3] = x >= size / 2 ? 255 : 0;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
function pdf() {
  const stream = "BT /F1 24 Tf 60 720 Td (DOCUMENT_RESTORATION_CODE_Z41) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const image = documentEvaluation ? pdf() : png();
const imageHash = digest(image);
if (fileDocument) await writeFile(join(workspace, "document.pdf"), image);
const fixtureMimeType = documentEvaluation ? "application/pdf" : "image/png";
const attachment = fileDocument
  ? { type: "file", path: join(workspace, "document.pdf"), displayName: "document.pdf" }
  : { type: "blob", displayName: documentEvaluation ? "document.pdf" : "diagram.png",
    mimeType: fixtureMimeType, data: image.toString("base64") };
const selection = {
  type: "selection", displayName: "Selected requirements", filePath: "/synthetic/OriginalSpec.ts",
  selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
  text: "RESTORATION_SELECTION_REQUIREMENT_41: require approval before implementation.",
};

function inspect(text) {
  let body;
  try { body = JSON.parse(text); } catch { return; }
  const images = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (["image", "input_image", "image_url", "document", "input_file", "file"].includes(value.type)) {
      const encoded = value.source?.data ?? value.image_url?.url ?? value.image_url ?? value.file_data ?? value.file?.file_data;
      const data = typeof encoded === "string" ? encoded.replace(/^data:[^,]+,/, "") : undefined;
      images.push({ type: value.type, ...(data ? { sha256: digest(Buffer.from(data, "base64")) } : {}) });
    }
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === "object") visit(item);
    }
  }
  visit(body);
  requests.push({ phase, images, matchingFixtureImages: images.filter((item) => item.sha256 === imageHash).length,
    selectionTextPresent: text.includes("RESTORATION_SELECTION_REQUIREMENT_41") });
}
if (!realModel) {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    inspect(text);
    const body = JSON.parse(text);
    const completion = { id: "synthetic-response", created: 0, model: "attachment-probe" };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta: { role: "assistant", content: "ACK" }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]) response.write(`data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [choice] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...completion, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }] }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
}
function connection() {
  return RuntimeConnection.forStdio({
    path: process.env.COPILOT_EVAL_CLI,
    args: ["--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--disable-client-telemetry"],
  });
}
function makeClient() {
  return new CopilotClient({
    connection: connection(), mode: "empty", baseDirectory: join(root, "home"),
    workingDirectory: workspace, logLevel: "none",
  });
}
function config() {
  return {
    model: realModel ? process.env.COPILOT_EVAL_MODEL || "gpt-6-astra" : "gpt-4.1",
    ...(!realModel ? { provider: { type: "openai", wireApi: "completions", baseUrl,
      modelId: "gpt-4.1", wireModel: "attachment-probe" } } : {}),
    availableTools: ["experiment_clear"], requestExtensions: true, enableConfigDiscovery: false,
    enableSessionStore: false, enableFileHooks: false, enableHostGitOperations: false,
    infiniteSessions: { enabled: true },
    onEvent: (event) => {
      if (event.type === "session.extensions.attachments_pushed") pushed.push(event.data.attachments);
    },
    tools: [{
      name: "experiment_clear", description: "Internal disposable evaluation only. Never call.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      skipPermission: true, isTerminal: true,
      handler: async () => {
        await session.rpc.history.clearContext({ prompt: "Synthetic retained state. Earlier attachments may remain in the journal, but no visual findings were retained. Wait for the next user request." });
        return "Cleared.";
      },
    }],
    onPermissionRequest: async () => ({ kind: "reject" }),
    systemMessage: {
      mode: "replace",
      content: "This is an isolated attachment preservation experiment. Do not use tools, files or network. Reply only ACK unless the user requests visual inspection. Never infer image details from filenames, metadata or previous text.",
    },
  };
}
async function send(name, attachments) {
  phase = name;
  if (process.env.COPILOT_EVAL_DEBUG === "1") console.error(phase);
  const before = requests.length;
  const prompt = realModel
    ? documentEvaluation
      ? "Read the actual attached PDF document available in context. Return only the exact code printed on its page. If no document content is available, reply NONE. Do not guess or use earlier textual descriptions."
      : "Inspect the actual image available in context. Reply with the four quadrant colors in order: top-left, top-right, bottom-left, bottom-right. If no image is available, reply NONE. Do not guess or use earlier textual descriptions."
    : "Reply ACK only; do not describe any attachment.";
  const response = await session.sendAndWait({ prompt, ...(attachments ? { attachments } : {}) }, 90000);
  observations.push({ phase, requestCount: requests.length - before, replyReceived: Boolean(response),
    ...(realModel ? { visualReply: response?.data.content } : {}) });
}
async function clearAndRestart() {
  await session.rpc.tools.execute({ name: "experiment_clear", arguments: {}, toolCallId: randomUUID() });
  await session.disconnect();
  const errors = await client.stop();
  assert.equal(errors.length, 0);
  client = makeClient();
  session = await client.resumeSession(sessionId, config());
}
function check(name, pass) { checks.push({ name, pass: Boolean(pass) }); }
function imageSeen(name) {
  return realModel
    ? observations.some((observation) => observation.phase === name &&
      (documentEvaluation ? (observation.visualReply || "").includes("DOCUMENT_RESTORATION_CODE_Z41")
        : /red[\s\S]*blue[\s\S]*yellow[\s\S]*cyan/i.test(observation.visualReply || "")))
    : requests.some((request) => request.phase === name && request.matchingFixtureImages > 0);
}
try {
  client = makeClient();
  session = await client.createSession(config());
  sessionId = session.sessionId;
  await send("initial", [attachment, selection]);
  const original = await session.getEvents();
  const message = original.find((event) => event.type === "user.message" && event.data.attachments?.length);
  assert.ok(message, "Record a native attachment before testing restoration");
  const recorded = message.data.attachments[0];
  const assets = original.filter((event) => event.type === "session.binary_asset");
  const journalBytes = assets.find((event) => event.data.assetId === recorded.assetId)?.data.data ?? recorded.data;
  observations.push({
    phase: "journal", recordedAssetReference: Boolean(recorded.assetId),
    recordedInlineBytes: typeof recorded.data === "string",
    binaryAssetEvents: assets.length,
    exactOriginalBytesRecoverable: typeof journalBytes === "string" && digest(Buffer.from(journalBytes, "base64")) === imageHash,
  });
  check("native-image-present-in-initial-model-request", imageSeen("initial"));
  if (!realModel) check("selected-text-present-in-initial-model-request",
    requests.some((request) => request.phase === "initial" && request.selectionTextPresent));

  await clearAndRestart();
  const resumed = await session.getEvents();
  check("original-attachment-event-survives-clear-and-restart", resumed.some((event) => event.id === message.id));
  const resumedOriginal = resumed.find((event) => event.id === message.id);
  const resumedBytes = resumed.find((event) => event.type === "session.binary_asset" &&
    event.data.assetId === recorded.assetId)?.data.data ?? resumedOriginal?.data.attachments[0].data;
  check("original-asset-bytes-survive-clear-and-restart", typeof resumedBytes === "string" &&
    digest(Buffer.from(resumedBytes, "base64")) === imageHash);
  await send("bare-clear-resume");
  check("bare-clear-does-not-automatically-reattach-image", realModel
    ? observations.some((observation) => observation.phase === "bare-clear-resume" && /\bNONE\b/.test(observation.visualReply || ""))
    : requests.some((request) => request.phase === "bare-clear-resume") &&
      requests.filter((request) => request.phase === "bare-clear-resume").every((request) => request.images.length === 0));

  await clearAndRestart();
  phase = "asset-reference-reattach";
  try {
    if (!recorded.assetId) throw new Error("No native asset reference was recorded for this attachment type");
    const { data, ...reference } = recorded;
    await send(phase, [reference]);
    observations.push({ phase, accepted: true });
  } catch (error) {
    observations.push({ phase, accepted: false, errorClass: error.constructor.name, message: error.message });
  }
  observations.push({ phase: "asset-reference-result", imageSent: imageSeen("asset-reference-reattach") });

  await clearAndRestart();
  const asset = (await session.getEvents()).find((event) => event.type === "session.binary_asset" &&
    typeof event.data.data === "string" && digest(Buffer.from(event.data.data, "base64")) === imageHash);
  const recovered = asset?.data.data ?? journalBytes;
  assert.ok(typeof recovered === "string" || fileDocument, "No original native bytes are available from the journal");
  const restorePhase = typeof recovered === "string" ? "journal-bytes-reattach" : "original-file-path-reattach";
  await send(restorePhase, typeof recovered === "string"
    ? [{ type: "blob", mimeType: asset?.data.mimeType ?? fixtureMimeType, displayName: recorded.displayName, data: recovered }]
    : [recorded]);
  check("journal-bytes-reattached-as-native-image", imageSeen(restorePhase));
  await session.disconnect();
  assert.equal((await client.stop()).length, 0);
  client = makeClient();
  session = await client.resumeSession(sessionId, config());
  await send("reattached-image-cold-resume");
  check("reattached-native-image-survives-another-cold-resume", imageSeen("reattached-image-cold-resume"));

  await clearAndRestart();
  phase = "control-connection-composer-push";
  try {
    await session.rpc.extensions.sendAttachmentsToMessage({ attachments: [attachment] });
    observations.push({ phase, accepted: true });
  } catch (error) {
    observations.push({ phase, accepted: false, errorClass: error.constructor.name, message: error.message });
  }
  phase = "extension-connection-composer-push";
  const extensions = await session.rpc.extensions.list();
  observations.push({ phase: "extension-discovery", extensions: extensions.extensions.map(({ name, source, status }) => ({ name, source, status })) });
  const beforePush = requests.length;
  const beforeTurns = (await session.getEvents()).filter((event) => event.type === "assistant.turn_start").length;
  const result = await session.rpc.commands.execute({ commandName: "attachment-probe-push", args: "" });
  observations.push({ phase, commandAccepted: !result.error, ...(result.error ? { error: result.error } : {}) });
  if (!result.error) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    check("extension-push-does-not-trigger-model-generation", requests.length === beforePush &&
      (await session.getEvents()).filter((event) => event.type === "assistant.turn_start").length === beforeTurns);
    check("extension-push-delivers-original-image-bytes-to-host", pushed.some((batch) =>
      batch.some((item) => item.type === "blob" && digest(Buffer.from(item.data, "base64")) === imageHash)));
    const bundle = pushed.at(-1);
    await send("push-without-host-forwarding");
    check("composer-push-alone-does-not-restore-model-image", realModel
      ? observations.some((item) => item.phase === "push-without-host-forwarding" && /\bNONE\b/.test(item.visualReply || ""))
      : requests.some((request) => request.phase === "push-without-host-forwarding") &&
        requests.filter((request) => request.phase === "push-without-host-forwarding").every((request) => request.images.length === 0));
    await send("host-forwards-pushed-attachment", bundle);
    check("host-forwarded-image-restored-natively", imageSeen("host-forwards-pushed-attachment"));
    check("pushed-composer-event-is-not-persisted", !(await session.getEvents())
      .some((event) => event.type === "session.extensions.attachments_pushed"));
    const count = pushed.length;
    await clearAndRestart();
    check("composer-push-is-not-automatically-reemitted-on-resume", pushed.length === count);
    const repeat = await session.rpc.commands.execute({ commandName: "attachment-probe-push", args: "" });
    check("extension-can-recover-and-repush-after-another-restart", !repeat.error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    observations.push({ phase: "recovered-push-after-restart", newPushes: pushed.length - count });
  }
  await clearAndRestart();
  const originalSelection = message.data.attachments.find((item) => item.type === "selection");
  assert.ok(originalSelection);
  await send("selection-reattach", [originalSelection]);
  if (!realModel) check("recorded-selection-restored-to-model-input", requests.some((request) =>
    request.phase === "selection-reattach" && request.selectionTextPresent && request.images.length === 0));
} catch (error) {
  observations.push({ phase, errorClass: error.constructor.name, message: error.message });
  check("experiment-completed", false);
  if (session) {
    try { await session.abort(); } catch (abortError) { observations.push({ phase: "abort", message: abortError.message }); }
  }
} finally {
  if (client) {
    if (sessionId) {
      try {
        await client.deleteSession(sessionId);
        check("disposable-session-deleted", !(await client.listSessions()).some((item) => item.sessionId === sessionId));
      } catch (error) { observations.push({ phase: "cleanup-delete", message: error.message }); check("disposable-session-deleted", false); }
    }
    try {
      const errors = await client.stop();
      check("runtime-stopped-cleanly", errors.length === 0);
      if (errors.length) await client.forceStop();
      stopped = true;
    } catch (error) {
      observations.push({ phase: "cleanup-stop", message: error.message });
      try { await client.forceStop(); stopped = true; } catch (failure) {
        observations.push({ phase: "cleanup-force-stop", message: failure.message });
      }
    }
  }
  if (stopped) await rm(root, { recursive: true, force: true });
  if (server) await new Promise((resolve) => server.close(resolve));
}
// Raw requests, credentials, native reasoning and session IDs are never emitted.
const report = { evidenceMode: realModel ? "real-model-visual-check" : "loopback-native-wire-capture",
  fixtureMimeType, attachmentTransport: fileDocument ? "file-path" : "inline-blob",
  checks, observations, requests, passed: checks.filter((check) => check.pass).length,
  failed: checks.filter((check) => !check.pass).length };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
