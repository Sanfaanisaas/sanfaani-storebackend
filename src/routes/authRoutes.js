import { Router } from "express";
import { register } from "../controllers/authController.js";
import { validate } from "../middleware/validate.js";
import { registerSchema } from "../utils/validators/authValidators.js";

const router = Router();

router.post("/register", validate(registerSchema), register);

export default router;