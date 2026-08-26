import { catchAsync } from "../utils/catchAsync.js";
import * as guidance from "../services/guidanceService.js";
export const createGuidance = catchAsync(async (req, res) => { const outcome = await guidance.createGuidance({ owner: req.user?.id || null, ...req.body }); res.status(201).json({ success: true, data: outcome }); });
export const resumeGuidance = catchAsync(async (req, res) => res.json({ success: true, data: await guidance.resumeGuidance({ id: req.params.id, token: req.get("X-Guidance-Resume-Token"), owner: req.user?.id || null }) }));
