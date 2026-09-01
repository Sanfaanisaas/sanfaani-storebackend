import { catchAsync } from "../utils/catchAsync.js";
import { getWarranty, listWarranties, warrantyEligibility } from "../services/warrantyCustomerService.js";
export const getMyWarranties = catchAsync(async (req, res) => res.json({ success: true, data: await listWarranties({ owner: req.user.id, query: req.query }) }));
export const getWarrantyDetail = catchAsync(async (req, res) => res.json({ success: true, data: await getWarranty({ owner: req.user.id, id: req.params.id }) }));
export const getWarrantyEligibility = catchAsync(async (req, res) => res.json({ success: true, data: await warrantyEligibility({ owner: req.user.id, id: req.params.id }) }));
