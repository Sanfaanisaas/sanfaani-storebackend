import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { listCustomerMaintenancePlans, getCustomerMaintenancePlan } from "../controllers/customerServicesController.js";
import { getMaintenancePlansQuerySchema, maintenancePlanIdParamSchema } from "../utils/validators/maintenancePlanValidators.js";

const router = Router();

/**
 * @swagger
 * /maintenance-plans/mine:
 *   get:
 *     summary: List customer maintenance plans
 *     tags: [MaintenancePlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Owner maintenance plans list
 */
router.get("/mine", authenticate, validate(getMaintenancePlansQuerySchema, "query"), listCustomerMaintenancePlans);

/**
 * @swagger
 * /maintenance-plans/{id}:
 *   get:
 *     summary: Get maintenance plan detail
 *     tags: [MaintenancePlans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Owner maintenance plan detail
 *       404:
 *         description: Maintenance plan unavailable
 */
router.get("/:id", authenticate, validate(maintenancePlanIdParamSchema, "params"), getCustomerMaintenancePlan);

export default router;
