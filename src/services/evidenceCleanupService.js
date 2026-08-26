import crypto from "node:crypto";
import mongoose from "mongoose";
import Evidence from "../models/Evidence.js";
import EvidenceCleanupTask from "../models/EvidenceCleanupTask.js";
import { deleteEvidenceObject, headEvidenceObject } from "./evidenceStorageService.js";
import { writeAuditLog } from "./auditService.js";

const MAX_BATCH_SIZE = 50;
const staleProcessingThreshold = (now) => new Date(now.getTime() - 5 * 60 * 1000);
const retryDelayMs = (attempt) => Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempt - 1)));
const cleanupKey = ({ taskType, evidenceId, objectKey }) => crypto.createHash("sha256").update(`${taskType}:${evidenceId || "none"}:${objectKey}`).digest("hex");
const errorCategory = () => "storage_unavailable";

export const queueEvidenceCleanup = async ({ taskType, evidenceId = null, objectKey, actorId, session }) => {
  const deduplicationKey = cleanupKey({ taskType, evidenceId, objectKey });
  const task = await EvidenceCleanupTask.findOneAndUpdate(
    { deduplicationKey },
    {
      $setOnInsert: {
        evidence: evidenceId,
        objectKey,
        taskType,
        deduplicationKey,
        createdBy: actorId,
        status: "PENDING",
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after", session, runValidators: true },
  );
  return task;
};

const claimTask = async (now) => EvidenceCleanupTask.findOneAndUpdate(
  {
    $or: [
      { status: "PENDING", nextAttemptAt: { $lte: now } },
      { status: "PROCESSING", updatedAt: { $lte: staleProcessingThreshold(now) } },
    ],
  },
  { $set: { status: "PROCESSING" }, $inc: { attempts: 1 } },
  { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: "after" },
).select("+objectKey");

const completeTask = async (task, now) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (task.taskType === "FINALIZE_DELETION" && task.evidence) {
        await Evidence.updateOne(
          { _id: task.evidence, retentionState: { $in: ["DELETE_PENDING", "ACTIVE"] } },
          { $set: { retentionState: "DELETED", deletedAt: now } },
          { session },
        );
      }
      await EvidenceCleanupTask.updateOne(
        { _id: task._id, status: "PROCESSING" },
        { $set: { status: "COMPLETED", completedAt: now, lastErrorCategory: null } },
        { session },
      );
      await writeAuditLog(task.createdBy, "EVIDENCE_CLEANUP_COMPLETED", "EvidenceCleanupTask", task._id, { taskType: task.taskType, attempts: task.attempts }, session);
    });
  } finally {
    await session.endSession();
  }
};

const retryTask = async (task, now) => {
  const exhausted = task.attempts >= task.maxAttempts;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await EvidenceCleanupTask.updateOne(
        { _id: task._id, status: "PROCESSING" },
        {
          $set: exhausted
            ? { status: "EXHAUSTED", lastErrorCategory: errorCategory(), nextAttemptAt: null }
            : { status: "PENDING", lastErrorCategory: errorCategory(), nextAttemptAt: new Date(now.getTime() + retryDelayMs(task.attempts)) },
        },
        { session },
      );
      if (exhausted) await writeAuditLog(task.createdBy, "EVIDENCE_CLEANUP_EXHAUSTED", "EvidenceCleanupTask", task._id, { taskType: task.taskType, attempts: task.attempts }, session);
    });
  } finally {
    await session.endSession();
  }
  return exhausted;
};

// Bounded and idempotent. A missing object is a successful deletion; this is
// essential after a worker crash between the external delete and DB finalization.
export const processEvidenceCleanupBatch = async ({ limit = 25, now = new Date() } = {}) => {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 25, MAX_BATCH_SIZE));
  const result = { processed: 0, completed: 0, retried: 0, exhausted: 0 };
  for (let index = 0; index < cappedLimit; index += 1) {
    const task = await claimTask(now);
    if (!task) break;
    result.processed += 1;
    try {
      const head = await headEvidenceObject(task.objectKey);
      if (head.exists) await deleteEvidenceObject(task.objectKey);
      await completeTask(task, now);
      result.completed += 1;
    } catch {
      if (await retryTask(task, now)) result.exhausted += 1;
      else result.retried += 1;
    }
  }
  return result;
};

export { MAX_BATCH_SIZE as MAX_EVIDENCE_CLEANUP_BATCH_SIZE };
