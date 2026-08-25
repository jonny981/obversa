import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Private temporary-file transfer: content moves to the caller as files in
 *  a 0700 directory with 0600 files, and the handoff carries each file's
 *  hash so the consumer can verify bytes before use. */
export async function createPrivateTransfer({ app, files }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError("A transfer needs at least one file");
  }
  const prefix = `${String(app).replace(/[^A-Za-z0-9._-]+/g, "-") || "surfacer"}-transfer-`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(directory, 0o700);
  const manifest = [];
  try {
    let index = 0;
    for (const file of files) {
      if (typeof file?.content !== "string" || file.content.includes("\0")) {
        throw new TypeError("Transfer content must be UTF-8 text without NUL bytes");
      }
      index += 1;
      const name = `${String(index).padStart(3, "0")}-${sanitizeName(file.name) || "content"}`;
      const filePath = path.join(directory, name);
      await fs.writeFile(filePath, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      manifest.push({
        path: filePath,
        hash: createHash("sha256").update(file.content).digest("hex"),
        bytes: Buffer.byteLength(file.content),
        encoding: "utf-8",
      });
    }
    return { directory, files: manifest };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function removeTransfer(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}

function sanitizeName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
}
