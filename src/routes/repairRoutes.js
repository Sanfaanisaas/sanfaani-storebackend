import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { createRepairSchema } from "../utils/validators/repairValidators.js";
import { 
  createRepair, 
  intakeRepair, 
  assignTechnician, 
  recordDiagnosis,
  createQuote,
  approveQuote,
  startRepair
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

export default router;
