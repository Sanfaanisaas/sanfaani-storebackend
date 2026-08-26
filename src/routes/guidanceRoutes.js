import { Router } from "express";
import { optionalAccessAuthentication } from "../middleware/optionalAuthenticate.js";
import { createGuidance, resumeGuidance } from "../controllers/guidanceController.js";
const router = Router();
router.post("/", optionalAccessAuthentication, createGuidance);
router.get("/:id", optionalAccessAuthentication, resumeGuidance);
export default router;
