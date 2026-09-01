import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { listCustomerMaintenancePlans, getCustomerMaintenancePlan } from "../controllers/customerServicesController.js";
const router = Router();
router.get("/mine", authenticate, listCustomerMaintenancePlans);
router.get("/:id", authenticate, getCustomerMaintenancePlan);
export default router;
