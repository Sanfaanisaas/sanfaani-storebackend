import { catchAsync } from "../utils/catchAsync.js";
import * as content from "../services/contentService.js";

const create = (kind) => catchAsync(async (req, res) => {
  const result = await content.createDraft({ kind, actor: req.user.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") });
  if (!result.created) res.set("Idempotency-Replayed", "true");
  res.status(result.created ? 201 : 200).json({ success: true, data: result.document });
});
const mutate = (kind, action) => catchAsync(async (req, res) => res.json({ success: true, data: await content.transition({ kind, action, actor: req.user.id, id: req.params.id, expectedStateVersion: req.body.expectedStateVersion }) }));

export const createPage = create("page");
export const createPolicy = create("policy");
export const submitPage = mutate("page", "submit");
export const approvePage = mutate("page", "approve");
export const publishPage = mutate("page", "publish");
export const archivePage = mutate("page", "archive");
export const submitPolicy = mutate("policy", "submit");
export const approvePolicy = mutate("policy", "approve");
export const publishPolicy = mutate("policy", "publish");
export const archivePolicy = mutate("policy", "archive");
export const previewPage = catchAsync(async (req, res) => res.json({ success: true, data: await content.preview("page", req.params.id) }));
export const previewPolicy = catchAsync(async (req, res) => res.json({ success: true, data: await content.preview("policy", req.params.id) }));
export const getPublicPage = catchAsync(async (req, res) => res.json({ success: true, data: await content.publicDocument("page", req.params.slug) }));
export const getPublicPolicy = catchAsync(async (req, res) => res.json({ success: true, data: await content.publicDocument("policy", req.params.key) }));
export const deletePolicy = catchAsync(async (req, res) => { await content.deletePolicyVersion({ actor: req.user.id, id: req.params.id }); res.status(204).send(); });
