import { catchAsync } from "../utils/catchAsync.js";
import * as procurement from "../services/procurementService.js";

const id = (value) => value?.toString?.() || value;
const supplierDto = (supplier) => ({
  id: id(supplier._id),
  name: supplier.name,
  email: supplier.email || null,
  phone: supplier.phone || null,
  active: supplier.active,
  version: supplier.__v,
  deactivatedAt: supplier.deactivatedAt || null,
  createdAt: supplier.createdAt,
  updatedAt: supplier.updatedAt,
});
const purchaseOrderDto = (po) => ({
  id: id(po._id),
  supplierId: id(po.supplier),
  status: po.status,
  version: po.__v,
  lines: po.lines.map((line) => ({
    variantId: id(line.variant),
    quantity: line.quantity,
    unitCost: line.unitCost,
    receivedQuantity: line.receivedQuantity,
  })),
  evidenceIds: (po.evidenceIds || []).map(id),
  receipts: (po.receipts || []).map((receipt) => ({
    id: id(receipt._id),
    variantId: id(receipt.variant),
    quantity: receipt.quantity,
    locationId: id(receipt.location),
    evidenceId: id(receipt.evidence),
    receivedAt: receipt.receivedAt,
  })),
  submittedAt: po.submittedAt || null,
  approvedAt: po.approvedAt || null,
  cancelledAt: po.cancelledAt || null,
  cancellationReason: po.cancellationReason || null,
  closedAt: po.closedAt || null,
  closeReason: po.closeReason || null,
  createdAt: po.createdAt,
  updatedAt: po.updatedAt,
});

export const createSupplier = catchAsync(async (req, res) =>
  res.status(201).json({ success: true, data: supplierDto(await procurement.createSupplier({ actor: req.user.id, ...req.body })) }));
export const listSuppliers = catchAsync(async (req, res) => {
  const result = await procurement.listSuppliers(req.query);
  res.json({ success: true, data: { ...result, items: result.items.map(supplierDto) } });
});
export const getSupplier = catchAsync(async (req, res) =>
  res.json({ success: true, data: supplierDto(await procurement.getSupplier(req.params.id)) }));
export const updateSupplier = catchAsync(async (req, res) =>
  res.json({ success: true, data: supplierDto(await procurement.updateSupplier({ supplierId: req.params.id, actor: req.user.id, ...req.body })) }));
export const deactivateSupplier = catchAsync(async (req, res) =>
  res.json({ success: true, data: supplierDto(await procurement.deactivateSupplier({ supplierId: req.params.id, actor: req.user.id, ...req.body })) }));

export const createPurchaseOrder = catchAsync(async (req, res) =>
  res.status(201).json({ success: true, data: purchaseOrderDto(await procurement.createPurchaseOrder({ actor: req.user.id, ...req.body })) }));
export const listPurchaseOrders = catchAsync(async (req, res) => {
  const result = await procurement.listPurchaseOrders(req.query);
  res.json({ success: true, data: { ...result, items: result.items.map(purchaseOrderDto) } });
});
export const getPurchaseOrder = catchAsync(async (req, res) =>
  res.json({ success: true, data: purchaseOrderDto(await procurement.getPurchaseOrder(req.params.id)) }));
export const submitPurchaseOrder = catchAsync(async (req, res) =>
  res.json({ success: true, data: purchaseOrderDto(await procurement.submitPurchaseOrder({ purchaseOrderId: req.params.id, actor: req.user.id })) }));
export const approvePurchaseOrder = catchAsync(async (req, res) =>
  res.json({ success: true, data: purchaseOrderDto(await procurement.approvePurchaseOrder({ purchaseOrderId: req.params.id, actor: req.user.id })) }));
export const cancelPurchaseOrder = catchAsync(async (req, res) =>
  res.json({ success: true, data: purchaseOrderDto(await procurement.cancelPurchaseOrder({ purchaseOrderId: req.params.id, actor: req.user.id, ...req.body })) }));
export const closePurchaseOrder = catchAsync(async (req, res) =>
  res.json({ success: true, data: purchaseOrderDto(await procurement.closePurchaseOrder({ purchaseOrderId: req.params.id, actor: req.user.id, ...req.body })) }));
export const receivePurchaseOrder = catchAsync(async (req, res) =>
  res.json({ success: true, data: purchaseOrderDto(await procurement.receivePurchaseOrderLine({ purchaseOrderId: req.params.id, actor: req.user.id, ...req.body })) }));
