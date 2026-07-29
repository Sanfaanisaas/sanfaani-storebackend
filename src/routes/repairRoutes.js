import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { createRepairSchema } from "../utils/validators/repairValidators.js";
import { createRepair, intakeRepair, assignTechnician, recordDiagnosis } from "../controllers/repairController.js";
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

export default router;
