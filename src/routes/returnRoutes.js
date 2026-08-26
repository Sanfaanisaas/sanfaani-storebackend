import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { USER_ROLES } from "../utils/constants.js";
import { createReturn, listMyReturns, decideReturn } from "../controllers/returnController.js";
const router = Router();
router.post("/orders/:orderId", authenticate, createReturn);
router.get("/mine", authenticate, listMyReturns);
router.patch("/:id/decision", authenticate, authorize(USER_ROLES.SUPPORT_OFFICER, USER_ROLES.FINANCE_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), decideReturn);
export default router;
