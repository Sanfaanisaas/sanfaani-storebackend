import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { createClaim } from "../controllers/claimController.js";

const router = Router();

router.post("/:id/claims", authenticate, createClaim);

export default router;
