import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const artifact = resolve(process.cwd(), "openapi/sanfaani-api.v1.json");
const dir = await mkdtemp(join(tmpdir(), "sanfaani-openapi-")); const generated = join(dir, "openapi.json");
try {
  const result = spawnSync(process.execPath, ["scripts/export-openapi.mjs", generated], { cwd: process.cwd(), stdio: "pipe", encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(result.stderr || "OpenAPI export failed");
  if (await readFile(artifact, "utf8") !== await readFile(generated, "utf8")) { process.stderr.write("OpenAPI artifact drift detected. Run: pnpm openapi:export\n"); process.exitCode = 1; }
} finally { await rm(dir, { recursive: true, force: true }); }
