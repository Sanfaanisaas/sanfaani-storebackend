import { Router } from "express";
import multer from "multer";
import { authenticate } from "../middleware/authenticate.js";
import { evidenceDownloadLimiter, evidenceUploadLimiter } from "../middleware/rateLimiter.js";
import AppError from "../utils/AppError.js";
import { MAX_EVIDENCE_FILES, MAX_EVIDENCE_FILE_BYTES } from "../services/evidenceStorageService.js";
import { downloadEvidence, deleteEvidence, uploadEvidence } from "../controllers/evidenceController.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_EVIDENCE_FILE_BYTES,
    files: MAX_EVIDENCE_FILES,
    fields: 3,
    fieldSize: 1024,
    // Multipart parsers count boundary bookkeeping differently across versions;
    // keep the field/file caps authoritative while allowing the required four
    // logical parts plus harmless framing.
    parts: 8,
  },
});

const parseEvidenceUpload = (req, res, next) => upload.single("file")(req, res, (error) => {
  if (!error) return next();
  return next(new AppError("Evidence upload violates file limits", 400, [{ code: "evidence_upload_limit", message: "Attach one supported file no larger than 5 MiB" }]));
});

/**
 * @swagger
 * /evidence:
 *   post:
 *     summary: Upload private workflow evidence
 *     description: Multipart endpoint. Requires bearer authentication, domain-scoped ownership or an authorized staff workflow role, exactly one JPEG, PNG, or PDF up to 5 MiB, and a valid domain-specific category. Objects are private and the response never contains an object key.
 *     tags: [Evidence]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [subjectType, subjectId, purpose, file]
 *             properties:
 *               subjectType: { type: string, enum: [order, repair, claim, return_request, purchase_order] }
 *               subjectId: { type: string }
 *               purpose: { type: string, enum: [order_receipt, repair_intake, custody, qc, handover, warranty, return, procurement] }
 *               file: { type: string, format: binary }
 *     responses:
 *       201: { description: Evidence metadata persisted and upload audited }
 *       400: { description: Invalid file, category, or multipart limits }
 *       403: { description: Unauthorized staff workflow role }
 *       404: { description: Non-enumerating unavailable foreign customer subject }
 *       429: { description: Upload rate limit exceeded }
 */
router.post("/", authenticate, evidenceUploadLimiter, parseEvidenceUpload, uploadEvidence);

/**
 * @swagger
 * /evidence/{id}/download:
 *   get:
 *     summary: Obtain a short-lived private evidence download URL
 *     description: Ownership and workflow roles are rechecked against the linked domain record. Foreign customer and unknown evidence use the same 404 envelope. The signed URL is not stored.
 *     tags: [Evidence]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Short-lived authorized download URL }
 *       404: { description: Non-enumerating unavailable evidence }
 *       429: { description: Download rate limit exceeded }
 */
router.get("/:id/download", authenticate, evidenceDownloadLimiter, downloadEvidence);

/**
 * @swagger
 * /evidence/{id}:
 *   delete:
 *     summary: Delete private evidence subject to retention policy
 *     description: Marks metadata as deletion-pending before external deletion. Failures create a bounded retryable cleanup task rather than hiding inconsistency.
 *     tags: [Evidence]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Object and metadata deleted }
 *       202: { description: Cleanup scheduled after storage failure }
 *       404: { description: Non-enumerating unavailable evidence }
 */
router.delete("/:id", authenticate, deleteEvidence);

export default router;
