import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { recordManualStockMovement } from "../controllers/inventoryController.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();

router.post(
  "/stock-movements",
  authenticate,
  authorize(USER_ROLES.INVENTORY_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  recordManualStockMovement
);

export default router;
