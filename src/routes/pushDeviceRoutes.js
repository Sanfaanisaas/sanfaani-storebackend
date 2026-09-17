import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { notificationLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { createPushDevice, deletePushDevice, getPushDevices } from "../controllers/pushDeviceController.js";
import { pushDeviceParamsSchema, registerPushDeviceSchema } from "../utils/validators/pushDeviceValidators.js";

const router = Router();
router.get("/", authenticate, notificationLimiter, getPushDevices);
router.post("/", authenticate, notificationLimiter, validate(registerPushDeviceSchema, "body"), createPushDevice);
router.delete("/:id", authenticate, notificationLimiter, validate(pushDeviceParamsSchema, "params"), deletePushDevice);
export default router;
