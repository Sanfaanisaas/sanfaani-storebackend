import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  createStockCount,
  listStockCounts,
  listStockDiscrepancies,
  recordManualStockMovement,
  releaseQuarantinedInventoryUnit,
  resolveStockDiscrepancy,
  returnInventoryUnitToStock,
  transferInventoryUnit,
} from "../controllers/inventoryController.js";
import { USER_ROLES } from "../utils/constants.js";
import {
  createStockCountSchema,
  discrepancyParamSchema,
  inventoryUnitParamSchema,
  manualStockMovementSchema,
  releaseInventoryUnitSchema,
  resolveStockDiscrepancySchema,
  stockCountQuerySchema,
  stockDiscrepancyQuerySchema,
  transferInventoryUnitSchema,
} from "../utils/validators/inventoryValidators.js";

const router = Router();
const operators = [USER_ROLES.INVENTORY_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];
const reconcilers = [USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];

/**
 * @swagger
 * /inventory/stock-movements:
 *   post:
 *     summary: Record an evidence-backed manual stock adjustment
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Stock and immutable ledger updated atomically }
 *       409: { description: Stock or idempotency conflict }
 */
router.post("/stock-movements", authenticate, authorize(...operators), validate(manualStockMovementSchema), recordManualStockMovement);

/** @swagger
 * /inventory/units/{id}/transfer:
 *   post:
 *     summary: Transfer one available serialized unit
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Unit transferred with ledger and audit facts }
 */
router.post("/units/:id/transfer", authenticate, authorize(...operators), validate(inventoryUnitParamSchema, "params"), validate(transferInventoryUnitSchema), transferInventoryUnit);
/** @swagger
 * /inventory/units/{id}/return-to-stock:
 *   post:
 *     summary: Return one inspected serialized unit to sellable stock
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Unit released once with stock, ledger, and audit facts }
 * /inventory/units/{id}/release-quarantine:
 *   post:
 *     summary: Release one inspected quarantined serialized unit
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Unit released once with stock, ledger, and audit facts }
 */
router.post("/units/:id/return-to-stock", authenticate, authorize(...operators), validate(inventoryUnitParamSchema, "params"), validate(releaseInventoryUnitSchema), returnInventoryUnitToStock);
router.post("/units/:id/release-quarantine", authenticate, authorize(...operators), validate(inventoryUnitParamSchema, "params"), validate(releaseInventoryUnitSchema), releaseQuarantinedInventoryUnit);

/** @swagger
 * /inventory/stock-counts:
 *   post:
 *     summary: Record an evidence-backed stock count and discrepancy
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Count recorded }
 *   get:
 *     summary: List stock counts
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Stock count queue }
 */
router.route("/stock-counts")
  .post(authenticate, authorize(...operators), validate(createStockCountSchema), createStockCount)
  .get(authenticate, authorize(...operators), validate(stockCountQuerySchema, "query"), listStockCounts);

/** @swagger
 * /inventory/discrepancies:
 *   get:
 *     summary: List controlled stock discrepancies
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Discrepancy queue }
 */
router.get("/discrepancies", authenticate, authorize(...operators), validate(stockDiscrepancyQuerySchema, "query"), listStockDiscrepancies);
/** @swagger
 * /inventory/discrepancies/{id}/resolve:
 *   post:
 *     summary: Resolve a discrepancy with evidence and an explicit governance decision
 *     tags: [Inventory]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Discrepancy resolved atomically }
 *       403: { description: Operations Manager or Super Administrator required }
 *       409: { description: Already resolved, stock conflict, or idempotency conflict }
 */
router.post("/discrepancies/:id/resolve", authenticate, authorize(...reconcilers), validate(discrepancyParamSchema, "params"), validate(resolveStockDiscrepancySchema), resolveStockDiscrepancy);

export default router;
