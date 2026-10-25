import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensions = {
  "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg",
  "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
  "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/tiff": ".tiff",
  "text/plain": ".txt",
};

const unavailableNotice = "No readable local file or recorded bytes are available. Retain any supplied text and provenance; recover from the recorded source only if permitted, otherwise report the missing evidence.";

function decodeBytes(encoded, metadata) {
  if (typeof encoded !== "string") throw new Error("Recorded attachment bytes are not valid base64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "") ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?){0,1}$/.test(encoded)) {
    throw new Error("Recorded attachment bytes are not valid base64");
  }
  verifyBytes(bytes, metadata);
  return bytes;
}

function verifyBytes(bytes, metadata) {
  if (metadata.byteLength !== undefined && metadata.byteLength !== bytes.length) {
    throw new Error("Recorded attachment byte length does not match the original");
  }
  const expected = metadata.sha256 ?? /^sha256:([a-f0-9]{64})$/i.exec(metadata.assetId ?? "")?.[1];
  if (expected && createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()) {
    throw new Error("Saved attachment bytes do not match the recorded original");
  }
}

export async function attachmentReferences(attachments, events, getWorkspace) {
  if (!attachments.length) return [];
  const assets = new Map(events.filter((event) => event.type === "session.binary_asset")
    .map((event) => [event.data.assetId, event.data]));
  const references = new Map();
  let workspace;
  const location = async () => workspace ??= await getWorkspace();
  for (const attachment of attachments) {
    const source = attachment.resource ?? attachment;
    const { data, blob, ...reference } = source;
    const asset = assets.get(source.assetId);
    reference.mimeType ??= asset?.mimeType;
    const image = /^image\//i.test(reference.mimeType ?? "");
    const encoded = image ? asset?.data ?? data ?? blob : data ?? blob ?? asset?.data;
    const hasBytes = encoded !== undefined && encoded !== null;
    let path = source.path ?? source.filePath ?? source.metadata?.path;
    if (!path && source.uri?.startsWith("file:")) path = fileURLToPath(source.uri);
    if (typeof path === "string" && path &&
        !(image && hasBytes) &&
        (typeof encoded !== "string" || ["file", "directory", "selection"].includes(source.type))) {
      if (!isAbsolute(path)) {
        const cwd = (await location()).workspace?.cwd;
        if (!cwd) throw new Error("Cannot resolve an attachment path without the session working directory");
        path = resolve(cwd, path);
      }
      reference.path = path;
      const savedBytes = typeof reference.sha256 === "string" &&
        path === join((await location()).path ?? "", "files", "context-prune-attachments",
          `${reference.sha256}${extensions[reference.mimeType?.toLowerCase()] ?? ".bin"}`);
      reference.notice ??= "File reference only. Reread with an appropriate permitted tool before relying on its contents; the file may have changed or disappeared.";
      if (image || savedBytes) {
        try {
          const bytes = await readFile(path);
          if (savedBytes) verifyBytes(bytes, reference);
          if (reference.unavailable) {
            reference.notice = savedBytes
              ? "Original recorded bytes saved as a durable file. Read with an appropriate permitted document/image tool before relying on its contents; saving is not inspection or native reattachment."
              : "File reference only. Reread with an appropriate permitted tool before relying on its contents; the file may have changed or disappeared.";
          }
          delete reference.unavailable;
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(error.code)) throw error;
          reference.notice = unavailableNotice;
          reference.unavailable = true;
        }
      }
    } else if (hasBytes) {
      const bytes = decodeBytes(encoded, image && asset?.data != null ? asset : source);
      if (image) verifyBytes(bytes, source);
      const root = (await location()).path;
      if (!root || !isAbsolute(root)) throw new Error("A local session workspace is required to save pasted attachment bytes");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const directory = join(root, "files", "context-prune-attachments");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const durablePath = join(directory, `${hash}${extensions[reference.mimeType?.toLowerCase()] ?? ".bin"}`);
      if (path && path !== durablePath) reference.originalPath ??= path;
      reference.path = durablePath;
      try {
        await writeFile(reference.path, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (!(await readFile(reference.path)).equals(bytes)) throw new Error("Saved attachment bytes do not match the recorded original");
      }
      reference.sha256 = hash;
      delete reference.unavailable;
      reference.notice = "Original recorded bytes saved as a durable file. Read with an appropriate permitted document/image tool before relying on its contents; saving is not inspection or native reattachment.";
    } else {
      reference.notice = unavailableNotice;
      reference.unavailable = true;
    }
    references.set(JSON.stringify(reference), reference);
  }
  return [...references.values()];
}
