import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { USER_ROLES } from "../utils/constants.js";
import { approvePage, approvePolicy, archivePage, archivePolicy, createPage, createPolicy, deletePolicy, getPublicPage, getPublicPolicy, previewPage, previewPolicy, publishPage, publishPolicy, submitPage, submitPolicy } from "../controllers/contentController.js";
import { contentIdParamsSchema, contentTransitionSchema, createContentPageSchema, createPolicyVersionSchema, publicPageParamsSchema, publicPolicyParamsSchema } from "../utils/validators/contentValidators.js";

const router = Router();
const editors = authorize(USER_ROLES.MERCHANDISER, USER_ROLES.PRODUCT_ADMIN, USER_ROLES.SUPER_ADMIN);
const publishers = authorize(USER_ROLES.PRODUCT_ADMIN, USER_ROLES.SUPER_ADMIN);
const transition = (controller, roles = editors) => [authenticate, roles, customerMutationLimiter, validate(contentIdParamsSchema, "params"), validate(contentTransitionSchema), controller];

/** @swagger
 * /content/admin/pages:
 *   post:
 *     summary: Create an immutable content-page draft version
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: header, name: Idempotency-Key, required: true, schema: { type: string } }]
 *     responses:
 *       201: { description: Draft created }
 *       403: { description: Content editor role required }
 *       409: { description: Idempotency or concurrent version conflict }
 */
router.post("/admin/pages", authenticate, editors, customerMutationLimiter, validate(createContentPageSchema), createPage);
/** @swagger
 * /content/admin/pages/{id}/preview:
 *   get:
 *     summary: Preview any content-page workflow version
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Staff-only preview }
 */
router.get("/admin/pages/:id/preview", authenticate, editors, validate(contentIdParamsSchema, "params"), previewPage);
/** @swagger
 * /content/admin/pages/{id}/submit:
 *   post: { summary: Submit a content page for review, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Submitted }, 409: { description: Invalid state or stale version } } }
 * /content/admin/pages/{id}/approve:
 *   post: { summary: Approve a reviewed content page, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Approved }, 403: { description: Independent publisher required } } }
 * /content/admin/pages/{id}/publish:
 *   post: { summary: Publish and supersede the prior public page version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Published } } }
 * /content/admin/pages/{id}/archive:
 *   post: { summary: Archive a non-current page version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Archived } } }
 */
router.post("/admin/pages/:id/submit", ...transition(submitPage));
router.post("/admin/pages/:id/approve", ...transition(approvePage, publishers));
router.post("/admin/pages/:id/publish", ...transition(publishPage, publishers));
router.post("/admin/pages/:id/archive", ...transition(archivePage, publishers));

/** @swagger
 * /content/admin/policies:
 *   post:
 *     summary: Create an immutable policy draft version
 *     tags: [Content]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: header, name: Idempotency-Key, required: true, schema: { type: string } }]
 *     responses:
 *       201: { description: Policy draft created }
 */
router.post("/admin/policies", authenticate, editors, customerMutationLimiter, validate(createPolicyVersionSchema), createPolicy);
/** @swagger
 * /content/admin/policies/{id}/preview:
 *   get: { summary: Preview any policy workflow version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Staff-only preview } } }
 * /content/admin/policies/{id}/submit:
 *   post: { summary: Submit a policy for review, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Submitted } } }
 * /content/admin/policies/{id}/approve:
 *   post: { summary: Independently approve a policy version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Approved }, 403: { description: Draft creator cannot self-approve } } }
 * /content/admin/policies/{id}/publish:
 *   post: { summary: Publish and supersede the prior public policy version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Published } } }
 * /content/admin/policies/{id}/archive:
 *   post: { summary: Archive a non-current policy version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 200: { description: Archived } } }
 * /content/admin/policies/{id}:
 *   delete: { summary: Delete only an unreferenced non-current policy version, tags: [Content], security: [{ bearerAuth: [] }], responses: { 204: { description: Deleted }, 409: { description: Current or referenced policy cannot be deleted } } }
 */
router.get("/admin/policies/:id/preview", authenticate, editors, validate(contentIdParamsSchema, "params"), previewPolicy);
router.post("/admin/policies/:id/submit", ...transition(submitPolicy));
router.post("/admin/policies/:id/approve", ...transition(approvePolicy, publishers));
router.post("/admin/policies/:id/publish", ...transition(publishPolicy, publishers));
router.post("/admin/policies/:id/archive", ...transition(archivePolicy, publishers));
router.delete("/admin/policies/:id", authenticate, publishers, customerMutationLimiter, validate(contentIdParamsSchema, "params"), deletePolicy);

/** @swagger
 * /content/pages/{slug}:
 *   get:
 *     summary: Get only the current published content-page version
 *     tags: [Content]
 *     responses:
 *       200: { description: Current public content page, content: { application/json: { schema: { $ref: '#/components/schemas/PublicContentPage' } } } }
 *       404: { description: No published version is available }
 */
router.get("/pages/:slug", validate(publicPageParamsSchema, "params"), getPublicPage);
/** @swagger
 * /content/policies/{key}:
 *   get:
 *     summary: Get only the current approved and published policy version
 *     tags: [Content]
 *     responses:
 *       200: { description: Current public policy, content: { application/json: { schema: { $ref: '#/components/schemas/PublicPolicyVersion' } } } }
 *       404: { description: No published policy version is available }
 */
router.get("/policies/:key", validate(publicPolicyParamsSchema, "params"), getPublicPolicy);

export default router;
