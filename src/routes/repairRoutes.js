import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { createRepairSchema } from "../utils/validators/repairValidators.js";
import { createRepair } from "../controllers/repairController.js";

const router = Router();

router.post("/", authenticate, validate(createRepairSchema), createRepair);

export default router;
