import { createHash } from "node:crypto";
import mongoose from "mongoose";
import Supplier from "../models/Supplier.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryLocation from "../models/InventoryLocation.js";
import Evidence from "../models/Evidence.js";
import { recordInventoryUnitMovement, recordStockMovement } from "./inventoryService.js";
import { writeAuditLog } from "./auditService.js";
import AppError from "../utils/AppError.js";
import { STOCK_MOVEMENT_REASON } from "../utils/constants.js";

const invalid = (message) =>
  new AppError(message, 400, [{ code: "procurement_invalid", message }]);
const conflict = (code, message) =>
  new AppError(message, 409, [{ code, message }]);
const unavailable = (label = "Procurement record") =>
  new AppError(`${label} is unavailable`, 404, [
    { code: "procurement_unavailable", message: "Check the record reference and permissions" },
  ]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const assertEvidence = async (evidenceId, purchaseOrderId, session) => {
  const evidence = await Evidence.findOne({
    _id: evidenceId,
    subjectType: "purchase_order",
    subject: purchaseOrderId,
    purpose: "procurement",
    retentionState: { $in: ["ACTIVE", "LEGAL_HOLD"] },
  }).session(session);
  if (!evidence) throw invalid("Retained purchase-order evidence is required");
  return evidence;
};

export const createSupplier = async ({ actor, name, email, phone }) => {
  const session = await mongoose.startSession();
  try {
    let supplier;
    await session.withTransaction(async () => {
      [supplier] = await Supplier.create([{
        name: String(name || "").trim(),
        email: email || undefined,
        phone: phone || undefined,
        createdBy: actor,
      }], { session });
      await writeAuditLog(actor, "SUPPLIER_CREATED", "Supplier", supplier._id, { active: true }, session);
    });
    return supplier;
  } finally {
    await session.endSession();
  }
};

export const listSuppliers = async ({ page = 1, limit = 20, active }) => {
  const query = typeof active === "boolean" ? { active } : {};
  const [items, total] = await Promise.all([
    Supplier.find(query).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Supplier.countDocuments(query),
  ]);
  return { items, page, limit, total };
};

export const getSupplier = async (supplierId) => {
  const supplier = await Supplier.findOne({ _id: { $eq: supplierId } }).lean();
  if (!supplier) throw unavailable("Supplier");
  return supplier;
};

export const updateSupplier = async ({ supplierId, actor, expectedVersion, name, email, phone }) => {
  const updates = { updatedBy: actor };
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email || undefined;
  if (phone !== undefined) updates.phone = phone || undefined;
  const session = await mongoose.startSession();
  try {
    let supplier;
    await session.withTransaction(async () => {
      supplier = await Supplier.findOneAndUpdate(
        { _id: { $eq: supplierId }, active: true, __v: expectedVersion },
        { $set: updates, $inc: { __v: 1 } },
        { returnDocument: "after", session, runValidators: true },
      );
      if (!supplier) throw conflict("supplier_version_conflict", "Supplier changed or is inactive");
      await writeAuditLog(actor, "SUPPLIER_UPDATED", "Supplier", supplier._id, { fields: Object.keys(updates).filter((key) => key !== "updatedBy") }, session);
    });
    return supplier;
  } finally {
    await session.endSession();
  }
};

export const deactivateSupplier = async ({ supplierId, actor, expectedVersion, reason }) => {
  const session = await mongoose.startSession();
  try {
    let supplier;
    await session.withTransaction(async () => {
      if (await PurchaseOrder.exists({ supplier: supplierId, status: { $in: ["PENDING_APPROVAL", "APPROVED", "RECEIVING"] } }).session(session))
        throw conflict("supplier_has_open_orders", "Supplier has active purchase orders");
      supplier = await Supplier.findOneAndUpdate(
        { _id: { $eq: supplierId }, active: true, __v: expectedVersion },
        { $set: { active: false, deactivatedBy: actor, deactivatedAt: new Date(), deactivationReason: reason }, $inc: { __v: 1 } },
        { returnDocument: "after", session, runValidators: true },
      );
      if (!supplier) throw conflict("supplier_version_conflict", "Supplier changed or is inactive");
      await writeAuditLog(actor, "SUPPLIER_DEACTIVATED", "Supplier", supplier._id, { reason }, session);
    });
    return supplier;
  } finally {
    await session.endSession();
  }
};

export const createPurchaseOrder = async ({ actor, supplier, lines, idempotencyKey }) => {
  const requestDigest = digest({ supplier, lines });
  const prior = await PurchaseOrder.findOne({ idempotencyKey: { $eq: idempotencyKey } });
  if (prior) {
    if (prior.requestDigest !== requestDigest)
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    return prior;
  }
  const session = await mongoose.startSession();
  try {
    let po;
    await session.withTransaction(async () => {
      // Touch the supplier in the same transaction. This serializes PO creation
      // against supplier deactivation instead of relying on a stale pre-check.
      const activeSupplier = await Supplier.findOneAndUpdate(
        { _id: supplier, active: true },
        { $inc: { procurementRevision: 1 } },
        { returnDocument: "after", session },
      );
      if (!activeSupplier) throw unavailable("Supplier");
      [po] = await PurchaseOrder.create([{ supplier, lines, createdBy: actor, idempotencyKey, requestDigest }], { session });
      await writeAuditLog(actor, "PURCHASE_ORDER_CREATED", "PurchaseOrder", po._id, { status: po.status, lineCount: po.lines.length }, session);
    });
    return po;
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await PurchaseOrder.findOne({ idempotencyKey: { $eq: idempotencyKey } });
      if (winner?.requestDigest === requestDigest) return winner;
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const listPurchaseOrders = async ({ page = 1, limit = 20, status, supplier }) => {
  const query = {};
  if (status) query.status = { $eq: status };
  if (supplier) query.supplier = { $eq: supplier };
  const [items, total] = await Promise.all([
    PurchaseOrder.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PurchaseOrder.countDocuments(query),
  ]);
  return { items, page, limit, total };
};

export const getPurchaseOrder = async (purchaseOrderId) => {
  const po = await PurchaseOrder.findOne({ _id: { $eq: purchaseOrderId } }).lean();
  if (!po) throw unavailable("Purchase order");
  return po;
};

const transitionPurchaseOrder = async ({ purchaseOrderId, actor, from, to, action, updates = {} }) => {
  const session = await mongoose.startSession();
  try {
    let po;
    await session.withTransaction(async () => {
      po = await PurchaseOrder.findOneAndUpdate(
        { _id: { $eq: purchaseOrderId }, status: { $in: from } },
        { $set: { status: to, ...updates } },
        { returnDocument: "after", session, runValidators: true },
      );
      if (!po) throw conflict("purchase_order_state_conflict", "Purchase order is not eligible for this transition");
      await writeAuditLog(actor, action, "PurchaseOrder", po._id, { status: po.status, reason: updates.cancellationReason || updates.closeReason }, session);
    });
    return po;
  } finally {
    await session.endSession();
  }
};

export const submitPurchaseOrder = ({ purchaseOrderId, actor }) =>
  transitionPurchaseOrder({
    purchaseOrderId,
    actor,
    from: ["DRAFT"],
    to: "PENDING_APPROVAL",
    action: "PURCHASE_ORDER_SUBMITTED",
    updates: { submittedBy: actor, submittedAt: new Date() },
  });

export const approvePurchaseOrder = ({ purchaseOrderId, actor }) =>
  transitionPurchaseOrder({
    purchaseOrderId,
    actor,
    from: ["PENDING_APPROVAL"],
    to: "APPROVED",
    action: "PURCHASE_ORDER_APPROVED",
    updates: { approvedBy: actor, approvedAt: new Date() },
  });

export const cancelPurchaseOrder = async ({ purchaseOrderId, actor, reason }) => {
  const session = await mongoose.startSession();
  try {
    let po;
    await session.withTransaction(async () => {
      po = await PurchaseOrder.findOne({ _id: { $eq: purchaseOrderId }, status: { $in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } }).session(session);
      if (!po) throw conflict("purchase_order_state_conflict", "Purchase order is not eligible for cancellation");
      if (po.lines.some((line) => line.receivedQuantity > 0))
        throw conflict("purchase_order_receipt_exists", "A purchase order with receipts cannot be cancelled");
      po.status = "CANCELLED";
      po.cancelledBy = actor;
      po.cancelledAt = new Date();
      po.cancellationReason = reason;
      await po.save({ session });
      await writeAuditLog(actor, "PURCHASE_ORDER_CANCELLED", "PurchaseOrder", po._id, { status: po.status, reason }, session);
    });
    return po;
  } finally {
    await session.endSession();
  }
};

export const closePurchaseOrder = async ({ purchaseOrderId, actor, reason }) => {
  const session = await mongoose.startSession();
  try {
    let po;
    await session.withTransaction(async () => {
      po = await PurchaseOrder.findOne({ _id: { $eq: purchaseOrderId }, status: { $in: ["APPROVED", "RECEIVING"] } }).session(session);
      if (!po) throw conflict("purchase_order_state_conflict", "Purchase order is not eligible for closure");
      if (!po.lines.every((line) => line.receivedQuantity === line.quantity))
        throw conflict("purchase_order_incomplete", "All approved quantities must be received before closure");
      po.status = "CLOSED";
      po.closedBy = actor;
      po.closedAt = new Date();
      po.closeReason = reason;
      await po.save({ session });
      await writeAuditLog(actor, "PURCHASE_ORDER_CLOSED", "PurchaseOrder", po._id, { status: po.status, reason }, session);
    });
    return po;
  } finally {
    await session.endSession();
  }
};

export const receivePurchaseOrderLine = async ({ purchaseOrderId, variantId, quantity, locationId, actor, serials = [], condition = "NEW", evidenceId, idempotencyKey }) => {
  const requestDigest = digest({ purchaseOrderId, variantId, quantity, locationId, serials, condition, evidenceId });
  const priorPo = await PurchaseOrder.findOne({ "receipts.idempotencyKey": { $eq: idempotencyKey } });
  const prior = priorPo?.receipts.find((item) => item.idempotencyKey === idempotencyKey);
  if (prior) {
    if (prior.requestDigest !== requestDigest)
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    return priorPo;
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const po = await PurchaseOrder.findOne({ _id: { $eq: purchaseOrderId }, status: { $in: ["APPROVED", "RECEIVING"] } }).session(session);
      const location = await InventoryLocation.exists({ _id: { $eq: locationId }, active: true }).session(session);
      if (!po || !location) throw conflict("purchase_order_receipt_unavailable", "Receipt is unavailable");
      await assertEvidence(evidenceId, po._id, session);
      const line = po.lines.find((item) => item.variant.toString() === String(variantId));
      if (!line || line.receivedQuantity + quantity > line.quantity)
        throw conflict("purchase_order_over_receipt", "Receipt exceeds approved quantity");
      if (serials.length && serials.length !== quantity)
        throw invalid("Serialized receipt requires one serial per unit");
      if (new Set(serials.map((value) => value.toUpperCase())).size !== serials.length)
        throw invalid("Serialized receipt contains duplicate serials");
      for (const serialNumber of serials) {
        const [unit] = await InventoryUnit.create([{
          variant: variantId,
          serialNumber,
          location: locationId,
          condition,
          inspectionState: "PENDING",
          state: "QUARANTINED",
          sourceReference: po._id.toString(),
          lastMovementAt: new Date(),
          lastMovementBy: actor,
        }], { session });
        await recordInventoryUnitMovement({
          unit,
          reason: STOCK_MOVEMENT_REASON.RESTOCK,
          actor,
          fromLocation: null,
          toLocation: locationId,
          idempotencyKey: `receipt-unit:${idempotencyKey}:${unit.serialNumber}`,
          requestDigest,
          note: "serialized_purchase_order_receipt",
          session,
        });
      }
      line.receivedQuantity += quantity;
      const fullyReceived = po.lines.every((item) => item.receivedQuantity >= item.quantity);
      po.status = fullyReceived && serials.length === 0 ? "CLOSED" : "RECEIVING";
      if (po.status === "CLOSED") {
        po.closedBy = actor;
        po.closedAt = new Date();
        po.closeReason = "fully_received";
      }
      po.evidenceIds.addToSet(evidenceId);
      po.receipts.push({ idempotencyKey, requestDigest, variant: variantId, quantity, location: locationId, evidence: evidenceId, receivedBy: actor, receivedAt: new Date() });
      await po.save({ session });
      if (serials.length === 0) {
        await recordStockMovement(variantId, quantity, STOCK_MOVEMENT_REASON.RESTOCK, actor, session, {
          toLocation: locationId,
          sourceType: "PurchaseOrder",
          sourceId: po._id,
          idempotencyKey: `receipt:${idempotencyKey}`,
          requestDigest,
          note: "purchase_order_receipt",
        });
      }
      await writeAuditLog(actor, "PURCHASE_ORDER_RECEIVED", "PurchaseOrder", po._id, { quantity, status: po.status, evidenceId: String(evidenceId), serialized: serials.length }, session);
      if (po.status === "CLOSED")
        await writeAuditLog(actor, "PURCHASE_ORDER_CLOSED", "PurchaseOrder", po._id, { status: po.status, reason: "fully_received" }, session);
      result = po;
    });
    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await PurchaseOrder.findOne({ "receipts.idempotencyKey": { $eq: idempotencyKey } });
      const receipt = winner?.receipts.find((item) => item.idempotencyKey === idempotencyKey);
      if (receipt?.requestDigest === requestDigest) return winner;
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};
