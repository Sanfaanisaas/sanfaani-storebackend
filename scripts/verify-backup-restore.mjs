import { createDecipheriv, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const [archive, metadataPath] = process.argv.slice(2);
const target = process.env.RESTORE_TEST_MONGO_URI; const key = process.env.BACKUP_ENCRYPTION_KEY;
if (!archive || !metadataPath || !target || !key || !/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("Usage: BACKUP_ENCRYPTION_KEY=... RESTORE_TEST_MONGO_URI=... node scripts/verify-backup-restore.mjs <archive.enc> <archive.enc.json>");
if (!/localhost|127\.0\.0\.1|mongodb-memory-server/i.test(target)) throw new Error("RESTORE_TEST_MONGO_URI must target an isolated local restore database");
const metadata = JSON.parse(await readFile(metadataPath, "utf8")); const ciphertext = await readFile(archive);
if (createHash("sha256").update(ciphertext).digest("hex") !== metadata.sha256) throw new Error("Backup integrity hash mismatch");
const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(metadata.iv, "base64")); decipher.setAuthTag(Buffer.from(metadata.tag, "base64")); const temporary = `${archive}.restore.archive.gz`; await writeFile(temporary, Buffer.concat([decipher.update(ciphertext), decipher.final()]));
try { await new Promise((resolveResult, reject) => { const child = spawn("mongorestore", ["--uri", target, "--drop", `--archive=${temporary}`, "--gzip"], { stdio: "inherit" }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolveResult() : reject(new Error(`mongorestore failed (${code})`))); }); process.stdout.write("isolated restore completed\n"); } finally { await import("node:fs/promises").then(({ unlink }) => unlink(temporary).catch(() => {})); }
