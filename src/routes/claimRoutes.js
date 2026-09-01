import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { updateClaimStatus, getMyClaims, getClaimDetail } from "../controllers/claimController.js";
import { USER_ROLES } from "../utils/constants.js";
const router = Router();
router.get("/mine", authenticate, getMyClaims);
router.get("/:id", authenticate, getClaimDetail);
router.patch("/:id/status", authenticate, authorize(USER_ROLES.SUPPORT_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), updateClaimStatus);
export default router;
