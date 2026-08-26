import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { createFinanceOverride, getReconciliation, listReconciliations, resolveReconciliation, revokeFinanceOverride } from "../controllers/financeController.js";
import { createFinanceOverrideSchema, financeOverrideIdParamSchema, reconciliationResolutionSchema, repairIdParamSchema, revokeFinanceOverrideSchema } from "../utils/validators/financeValidators.js";
import { USER_ROLES } from "../utils/constants.js";
const router = Router();
const financeRoles = [USER_ROLES.FINANCE_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];
router.get("/reconciliations", authenticate, authorize(...financeRoles), listReconciliations);
router.get("/reconciliations/:id", authenticate, authorize(...financeRoles), getReconciliation);
router.post("/reconciliations/:id/resolve", authenticate, authorize(...financeRoles), validate(reconciliationResolutionSchema), resolveReconciliation);
/**
 * @swagger
 * /finance/repairs/{repairId}/overrides:
 *   post:
 *     summary: Create a bounded, audited repair-finance gate override
 *     description: Finance officer, operations manager, or super administrator only. An override is scoped, records before/after derived gate state, and never changes provider payment history.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Active override created }
 *       403: { description: Finance role required }
 *       400: { description: Invalid scope or bounded reason }
 */
router.post("/repairs/:repairId/overrides", authenticate, authorize(...financeRoles), validate(repairIdParamSchema, "params"), validate(createFinanceOverrideSchema), createFinanceOverride);
/**
 * @swagger
 * /finance/repair-finance-overrides/{overrideId}/revoke:
 *   post:
 *     summary: Revoke a repair-finance gate override
 *     description: Finance-only. Revocation is transactional and re-evaluates the trusted financial gate without rewriting provider history.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Override revoked }
 *       403: { description: Finance role required }
 *       409: { description: Override is no longer active }
 */
router.post("/repair-finance-overrides/:overrideId/revoke", authenticate, authorize(...financeRoles), validate(financeOverrideIdParamSchema, "params"), validate(revokeFinanceOverrideSchema), revokeFinanceOverride);
export default router;
