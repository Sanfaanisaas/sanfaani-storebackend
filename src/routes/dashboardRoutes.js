import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { getDashboardQueue } from "../controllers/dashboardController.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();

router.get(
  "/queue",
  authenticate,
  authorize(
    USER_ROLES.STORE_OPERATOR,
    USER_ROLES.TECHNICIAN,
    USER_ROLES.QC_OFFICER,
    USER_ROLES.SALES_ADVISOR,
    USER_ROLES.INVENTORY_OFFICER,
    USER_ROLES.FINANCE_OFFICER,
    USER_ROLES.SUPPORT_OFFICER,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.SUPER_ADMIN,
    USER_ROLES.TECH_ADMIN,
    USER_ROLES.PRODUCT_ADMIN
  ),
  getDashboardQueue
);

export default router;
