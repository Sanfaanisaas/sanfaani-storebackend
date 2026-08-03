import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { 
  createRepairSchema, 
  getRepairsQuerySchema 
} from "../utils/validators/repairValidators.js";
import { 
  createRepair, 
  intakeRepair, 
  assignTechnician, 
  recordDiagnosis,
  createQuote,
  approveQuote,
  startRepair,
  completeRepairWork,
  addWorkLog,
  performQC,
  handoverRepair,
  trackRepair,
  getRepairQueue
} from "../controllers/repairController.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();

router.post("/", authenticate, validate(createRepairSchema), createRepair);

router.patch(
  "/:id/intake",
  authenticate,
  authorize(USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  intakeRepair
);

router.patch(
  "/:id/assign-technician",
  authenticate,
  authorize(USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  assignTechnician
);

router.patch(
  "/:id/diagnosis",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN),
  recordDiagnosis
);

router.post(
  "/:id/quote",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  createQuote
);

router.patch(
  "/:id/quote/:quoteId/approve",
  authenticate,
  approveQuote
);

router.patch(
  "/:id/start",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  startRepair
);

router.patch(
  "/:id/complete",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN),
  completeRepairWork
);

router.post(
  "/:id/log",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.QC_OFFICER, USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  addWorkLog
);

router.patch(
  "/:id/qc",
  authenticate,
  authorize(USER_ROLES.QC_OFFICER, USER_ROLES.SUPER_ADMIN),
  performQC
);

router.patch(
  "/:id/handover",
  authenticate,
  authorize(USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  handoverRepair
);

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
    USER_ROLES.PRODUCT_ADMIN,
    USER_ROLES.TECH_ADMIN,
    USER_ROLES.SUPER_ADMIN
  ),
  validate(getRepairsQuerySchema, "query"),
  getRepairQueue
);

router.get("/:id/track", trackRepair);

export default router;
