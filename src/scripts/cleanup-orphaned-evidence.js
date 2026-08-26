import mongoose from "mongoose";
import { env } from "../config/env.js";
import { processEvidenceCleanupBatch } from "../services/evidenceCleanupService.js";

const main = async () => {
  await mongoose.connect(env.mongoUri);
  try {
    const result = await processEvidenceCleanupBatch({ limit: Number(process.env.EVIDENCE_CLEANUP_BATCH_SIZE) || 25 });
    // Intentionally no object key, URL, credentials, or provider diagnostics.
    console.log(JSON.stringify({ evidenceCleanup: result }));
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error("Evidence cleanup worker failed", error?.message || "unknown error");
  process.exitCode = 1;
});
