import { Router } from "express";
import multer from "multer";
import { authenticate } from "../middleware/authenticate.js";
import { downloadEvidence, deleteEvidence, uploadEvidence } from "../controllers/evidenceController.js";
const router = Router(); const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
router.post("/", authenticate, upload.single("file"), uploadEvidence);
router.get("/:id/download", authenticate, downloadEvidence);
router.delete("/:id", authenticate, deleteEvidence);
export default router;
