import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const uri = process.env.MONGO_URI;
const key = process.env.BACKUP_ENCRYPTION_KEY;
const directory = resolve(process.env.BACKUP_PATH || "./backups");
if (!uri || !key || !/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("MONGO_URI and a 64-hex BACKUP_ENCRYPTION_KEY are required");
await mkdir(directory, { recursive: true });
const raw = join(directory, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.archive.gz`);
await new Promise((resolveResult, reject) => {
  const child = spawn("mongodump", ["--uri", uri, `--archive=${raw}`, "--gzip"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveResult() : reject(new Error(`mongodump failed (exit ${code}): ${stderr.replace(uri, "[redacted]").slice(0, 500)}`)));
});
try {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv); const ciphertext = Buffer.concat([cipher.update(await readFile(raw)), cipher.final()]); const tag = cipher.getAuthTag(); const encrypted = `${raw}.enc`; const digest = createHash("sha256").update(ciphertext).digest("hex");
  await writeFile(encrypted, ciphertext, { mode: 0o600 }); await writeFile(`${encrypted}.json`, `${JSON.stringify({ algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: tag.toString("base64"), sha256: digest, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 }); await unlink(raw);
  process.stdout.write(JSON.stringify({ backup: encrypted, sha256: digest, encrypted: true }) + "\n");
} catch (error) { await unlink(raw).catch(() => {}); throw error; }
