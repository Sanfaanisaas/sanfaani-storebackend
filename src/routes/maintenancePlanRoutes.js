import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { cancelStaffMaintenancePlan, createStaffMaintenancePlan, getCustomerMaintenancePlan, listCustomerMaintenancePlans, listStaffMaintenancePlans, renewStaffMaintenancePlan, updateStaffMaintenancePlan } from "../controllers/customerServicesController.js";
import { cancelMaintenancePlanSchema, createMaintenancePlanSchema, getMaintenancePlansQuerySchema, maintenancePlanIdParamSchema, renewMaintenancePlanSchema, updateMaintenancePlanSchema } from "../utils/validators/maintenancePlanValidators.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();
const operations = authorize(USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN);

/**
 * @swagger
 * /maintenance-plans:
 *   post:
 *     summary: Create a customer maintenance plan (Operations)
 *     tags: [MaintenancePlans]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Maintenance plan created }
 *   get:
 *     summary: List maintenance plans for administration (Operations)
 *     tags: [MaintenancePlans]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Maintenance plan administration list }
 */
router.post("/", authenticate, operations, validate(createMaintenancePlanSchema, "body"), createStaffMaintenancePlan);
router.get("/", authenticate, operations, validate(getMaintenancePlansQuerySchema, "query"), listStaffMaintenancePlans);

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
 *   patch:
 *     summary: Update editable maintenance-plan terms (Operations)
 *     tags: [MaintenancePlans]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Maintenance plan updated }
 *       409: { description: Version or plan-state conflict }
 */
router.patch("/:id", authenticate, operations, validate(maintenancePlanIdParamSchema, "params"), validate(updateMaintenancePlanSchema, "body"), updateStaffMaintenancePlan);

/**
 * @swagger
 * /maintenance-plans/{id}/cancel:
 *   post:
 *     summary: Cancel a maintenance plan (Operations)
 *     tags: [MaintenancePlans]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Maintenance plan cancelled }
 */
router.post("/:id/cancel", authenticate, operations, validate(maintenancePlanIdParamSchema, "params"), validate(cancelMaintenancePlanSchema, "body"), cancelStaffMaintenancePlan);

/**
 * @swagger
 * /maintenance-plans/{id}/renew:
 *   post:
 *     summary: Create a successor maintenance-plan term (Operations)
 *     tags: [MaintenancePlans]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Successor maintenance-plan term created }
 */
router.post("/:id/renew", authenticate, operations, validate(maintenancePlanIdParamSchema, "params"), validate(renewMaintenancePlanSchema, "body"), renewStaffMaintenancePlan);

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
