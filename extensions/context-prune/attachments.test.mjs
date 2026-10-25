import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentReferences } from "./attachments.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), ".attachment-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace: async () => ({ path: root, workspace: { cwd: root } }) };
}

test("file references resolve against the session cwd without reading or snapshotting the document", async (t) => {
  const f = await fixture(t);
  const refs = await attachmentReferences([
    { type: "file", path: "unread.pdf", mimeType: "application/pdf", displayName: "Requirements" },
    { type: "selection", filePath: join(f.root, "source.ts"), text: "Keep the selection." },
  ], [], f.workspace);
  assert.equal(refs[0].path, join(f.root, "unread.pdf"));
  assert.match(refs[0].notice, /Reread.*may have changed/);
  assert.equal(refs[1].text, "Keep the selection.");
  await assert.rejects(readFile(refs[0].path), { code: "ENOENT" });
});

test("inline and journal-backed pasted bytes become private durable content-addressed files", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("Synthetic original PDF bytes.");
  const data = bytes.toString("base64");
  const attachments = [
    { type: "blob", displayName: "../../outside.pdf", mimeType: "application/pdf", data,
      metadata: { path: "/expired/temporary.pdf" } },
    { type: "image_ref", assetId: "sha256:test" },
  ];
  const events = [{ type: "session.binary_asset", data: { assetId: "sha256:test", data, mimeType: "application/pdf" } }];
  const original = structuredClone({ attachments, events });
  const refs = await attachmentReferences(attachments, events, f.workspace);
  assert.equal(refs[0].path, refs[1].path);
  assert.equal(await readFile(refs[0].path, "utf8"), bytes.toString());
  assert.equal((await stat(refs[0].path)).mode & 0o777, 0o600);
  assert.match(refs[0].path, /files\/context-prune-attachments\/[a-f0-9]{64}\.pdf$/);
  assert.doesNotMatch(JSON.stringify(refs), new RegExp(data));
  assert.match(refs[0].notice, /saving is not inspection or native reattachment/);
  assert.deepEqual({ attachments, events }, original);
  assert.deepEqual(await attachmentReferences(refs, events, f.workspace), refs);
  assert.deepEqual(await attachmentReferences(attachments, events, f.workspace), refs);
});

test("binary resource bytes are saved and remote-only resources expose their recovery gap", async (t) => {
  const f = await fixture(t);
  const refs = await attachmentReferences([
    { type: "resource", resource: { uri: "fixture://document", mimeType: "application/pdf", blob: "cGRm" } },
    { type: "resource", resource: { uri: "fixture://expired", mimeType: "application/pdf" } },
    { type: "blob", assetId: "missing", mimeType: "image/png", omittedReason: "size_limit" },
  ], [], f.workspace);
  assert.equal(await readFile(refs[0].path, "utf8"), "pdf");
  assert.equal(refs[1].uri, "fixture://expired");
  assert.equal(refs[1].unavailable, true);
  assert.equal(refs[2].omittedReason, "size_limit");
  assert.equal(refs[2].unavailable, true);
});

test("invalid bytes, unknown relative-path cwd and absent local workspace fail explicitly", async () => {
  await assert.rejects(attachmentReferences([{ data: "%%%bad%%%" }], [], async () => ({})), /valid base64/);
  await assert.rejects(attachmentReferences([{ path: "relative.pdf" }], [], async () => ({})), /working directory/);
  await assert.rejects(attachmentReferences([{ data: "cGRm" }], [], async () => ({})), /local session workspace/);
});

test("existing corrupted saved bytes are never overwritten or claimed as the original", async (t) => {
  const f = await fixture(t);
  const attachments = [{ type: "blob", mimeType: "application/pdf", data: "cGRm" }];
  const [ref] = await attachmentReferences(attachments, [], f.workspace);
  await writeFile(ref.path, "changed");
  await assert.rejects(attachmentReferences(attachments, [], f.workspace), /do not match/);
  assert.equal(await readFile(ref.path, "utf8"), "changed");
});

for (const mimeType of ["application/pdf", "text/plain"]) {
  test(`saved ${mimeType} references validate original bytes across replay without journal payloads`, async (t) => {
    const f = await fixture(t);
    const bytes = Buffer.from("original");
    const [ref] = await attachmentReferences([
      { type: "blob", mimeType, data: bytes.toString("base64") },
    ], [], f.workspace);
    assert.deepEqual(await attachmentReferences([ref], [], f.workspace), [ref]);
    await writeFile(ref.path, "modified");
    await assert.rejects(attachmentReferences([ref], [], f.workspace), /do not match/);
    assert.equal(await readFile(ref.path, "utf8"), "modified");
    await rm(ref.path);
    const [missing] = await attachmentReferences([ref], [], f.workspace);
    assert.equal(missing.unavailable, true);
    assert.match(missing.notice, /No readable local file or recorded bytes/);
    await writeFile(ref.path, bytes);
    assert.deepEqual(await attachmentReferences([missing], [], f.workspace), [ref]);
  });
}

test("ordinary document and image paths remain mutable even with original checksum metadata", async (t) => {
  const f = await fixture(t);
  const original = Buffer.from("original");
  const sha256 = createHash("sha256").update(original).digest("hex");
  for (const mimeType of ["application/pdf", "text/plain", "image/png"]) {
    const path = join(f.root, mimeType.replace("/", "-"));
    await writeFile(path, original);
    const [ref] = await attachmentReferences([
      { type: "file", path, mimeType, sha256, assetId: `sha256:${sha256}`, byteLength: original.length },
    ], [], f.workspace);
    await writeFile(path, "updated content of a different length");
    assert.deepEqual(await attachmentReferences([ref], [], f.workspace), [ref]);
    assert.equal(await readFile(ref.path, "utf8"), "updated content of a different length");
  }
});

test("native clipboard image journal bytes win over existing and deleted source paths", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("Recorded original image");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const assetId = `sha256:${hash}`;
  const path = join(f.root, "clipboard.png");
  await writeFile(path, "Different current image");
  const attachment = { type: "file", path, assetId, mimeType: "image/png", byteLength: bytes.length };
  const events = [{ type: "session.binary_asset", data: {
    assetId, data: bytes.toString("base64"), mimeType: "image/png", byteLength: bytes.length,
  } }];
  const [ref] = await attachmentReferences([attachment], events, f.workspace);
  assert.equal(ref.path, join(f.root, "files", "context-prune-attachments", `${hash}.png`));
  assert.equal(ref.originalPath, path);
  assert.deepEqual(await readFile(ref.path), bytes);
  assert.equal((await stat(ref.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "files", "context-prune-attachments"))).mode & 0o777, 0o700);
  await rm(path);
  assert.deepEqual(await attachmentReferences([attachment, attachment], events, f.workspace), [ref]);
  assert.deepEqual(await attachmentReferences([ref], events, f.workspace), [ref]);
  assert.deepEqual(await attachmentReferences([ref], [], f.workspace), [ref]);
});

test("ordinary documents and pasted text keep existing paths even with recorded bytes", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "pasted.txt");
  await writeFile(path, "source text");
  const attachments = [
    { type: "file", path, assetId: "text", mimeType: "text/plain" },
    { type: "file", path: join(f.root, "document.pdf"), assetId: "pdf", mimeType: "application/pdf" },
  ];
  const events = ["text", "pdf"].map((assetId) => ({
    type: "session.binary_asset", data: { assetId, data: "%%%invalid%%%" },
  }));
  const refs = await attachmentReferences(attachments, events, f.workspace);
  assert.equal(refs[0].path, path);
  assert.equal(refs[1].path, attachments[1].path);
  assert.equal(refs[1].unavailable, undefined);
  await assert.rejects(stat(join(f.root, "files")), { code: "ENOENT" });
});

test("inline image bytes with a file path persist and journal bytes take precedence", async (t) => {
  const f = await fixture(t);
  const attachment = { type: "file", path: "/expired/image.png", mimeType: "image/png", data: "aW1hZ2U=" };
  const [inline] = await attachmentReferences([attachment], [], f.workspace);
  assert.equal(await readFile(inline.path, "utf8"), "image");
  const [recorded] = await attachmentReferences([{ ...attachment, assetId: "image", data: "bad!" }], [
    { type: "session.binary_asset", data: { assetId: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" } },
  ], f.workspace);
  assert.equal(await readFile(recorded.path, "utf8"), "original");
});

test("images without bytes expose unreadable paths but do not snapshot readable image files", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "attached.png");
  await writeFile(path, "image");
  const [readable, missing, remote] = await attachmentReferences([
    { type: "file", path, mimeType: "image/png" },
    { type: "file", path: join(f.root, "missing.png"), mimeType: "image/png" },
    { mimeType: "image/png", uri: "https://example.invalid/image" },
  ], [], f.workspace);
  assert.equal(readable.path, path);
  assert.equal(readable.unavailable, undefined);
  assert.equal(missing.unavailable, true);
  assert.match(missing.notice, /No readable local file or recorded bytes/);
  assert.equal(remote.unavailable, true);
  await assert.rejects(stat(join(f.root, "files")), { code: "ENOENT" });
  await writeFile(missing.path, "recovered image");
  const [recovered] = await attachmentReferences([missing], [], f.workspace);
  assert.equal(recovered.unavailable, undefined);
  assert.match(recovered.notice, /Reread.*may have changed/);
});

test("invalid image bytes never fall back to a readable source", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "source.png");
  await writeFile(path, "image");
  const source = { type: "file", path, mimeType: "image/png", assetId: "image" };
  for (const data of ["%%%", "aW1hZ2U==", "aW1hZ2U=\n", "aW1hZ2V=", 42]) {
    await assert.rejects(attachmentReferences([source], [
      { type: "session.binary_asset", data: { assetId: "image", data } },
    ], f.workspace), /valid base64/);
  }
  await assert.rejects(attachmentReferences([{ ...source, data: "aW1hZ2U=", byteLength: 99 }], [], f.workspace), /byte length/);
  await assert.rejects(attachmentReferences([{
    ...source, data: "aW1hZ2U=", assetId: `sha256:${"0".repeat(64)}`,
  }], [], f.workspace), /do not match/);
});

test("image persistence and durable-file corruption errors propagate without fallback", async (t) => {
  const f = await fixture(t);
  const source = { type: "file", path: join(f.root, "source.png"), mimeType: "image/png", data: "aW1hZ2U=" };
  await writeFile(source.path, "readable image");
  await assert.rejects(attachmentReferences([source], [], async () => ({})), /local session workspace/);
  const [ref] = await attachmentReferences([source], [], f.workspace);
  await writeFile(ref.path, "corruption");
  await assert.rejects(attachmentReferences([source], [], f.workspace), /do not match/);
  await assert.rejects(attachmentReferences([ref], [], f.workspace), /do not match/);
  const blocked = join(f.root, "not-a-directory");
  await writeFile(blocked, "block persistence");
  await assert.rejects(attachmentReferences([source], [], async () => ({ path: blocked })), { code: "ENOTDIR" });
});
