import { catchAsync } from "../utils/catchAsync.js";
import * as procurement from "../services/procurementService.js";
export const createSupplier = catchAsync(async (req, res) => res.status(201).json({ success: true, data: await procurement.createSupplier({ actor: req.user.id, ...req.body }) }));
export const createPurchaseOrder = catchAsync(async (req, res) => res.status(201).json({ success: true, data: await procurement.createPurchaseOrder({ actor: req.user.id, ...req.body }) }));
export const approvePurchaseOrder = catchAsync(async (req, res) => res.json({ success: true, data: await procurement.approvePurchaseOrder({ purchaseOrderId: req.params.id, actor: req.user.id }) }));
export const receivePurchaseOrder = catchAsync(async (req, res) => res.json({ success: true, data: await procurement.receivePurchaseOrderLine({ purchaseOrderId: req.params.id, actor: req.user.id, ...req.body }) }));
