import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { getDashboardQueue } from "../controllers/dashboardController.js";

const router = Router();

router.get("/queue", authenticate, getDashboardQueue);

export default router;
