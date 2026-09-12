import mongoose from "mongoose";
import Supplier from "../models/Supplier.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryLocation from "../models/InventoryLocation.js";
import { recordStockMovement } from "./inventoryService.js";
import { writeAuditLog } from "./auditService.js";
import AppError from "../utils/AppError.js";

const invalid = (message) =>
  new AppError(message, 400, [{ code: "procurement_invalid", message }]);
export const createSupplier = async ({ actor, name, email, phone }) =>
  Supplier.create({
    name: String(name || "").trim(),
    email: email || undefined,
    phone: phone || undefined,
    createdBy: actor,
  });
export const createPurchaseOrder = async ({ actor, supplier, lines }) => {
  if (
    !mongoose.isObjectIdOrHexString(supplier) ||
    !Array.isArray(lines) ||
    !lines.length ||
    lines.length > 100
  )
    throw invalid("Purchase order input is invalid");
  for (const line of lines)
    if (
      !mongoose.isObjectIdOrHexString(line.variant) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      !Number.isSafeInteger(line.unitCost) ||
      line.unitCost < 0
    )
      throw invalid(
        "Purchase order lines must use integer quantities and costs",
      );
  if (!(await Supplier.exists({ _id: supplier, active: true })))
    throw new AppError("Supplier is unavailable", 404);
  return PurchaseOrder.create({ supplier, lines, createdBy: actor });
};
export const approvePurchaseOrder = async ({ purchaseOrderId, actor }) => {
  const po = await PurchaseOrder.findOneAndUpdate(
    { _id: purchaseOrderId, status: "PENDING_APPROVAL" },
    { $set: { status: "APPROVED", approvedBy: actor } },
    { returnDocument: "after" },
  );
  if (!po) throw new AppError("Purchase order is unavailable", 409);
  await writeAuditLog(
    actor,
    "PURCHASE_ORDER_APPROVED",
    "PurchaseOrder",
    po._id,
    { status: po.status },
  );
  return po;
};
export const receivePurchaseOrderLine = async ({
  purchaseOrderId,
  variantId,
  quantity,
  locationId,
  actor,
  serials = [],
  condition = "NEW",
}) => {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    serials.length > quantity ||
    !mongoose.isObjectIdOrHexString(locationId)
  )
    throw invalid("Receipt input is invalid");
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const po = await PurchaseOrder.findOne({
        _id: purchaseOrderId,
        status: { $in: ["APPROVED", "RECEIVING"] },
      }).session(session);
      const location = await InventoryLocation.exists({
        _id: locationId,
        active: true,
      }).session(session);
      if (!po || !location) throw new AppError("Receipt is unavailable", 409);
      const line = po.lines.find(
        (item) => item.variant.toString() === String(variantId),
      );
      if (!line || line.receivedQuantity + quantity > line.quantity)
        throw new AppError("Receipt exceeds approved quantity", 409);
      if (serials.length && serials.length !== quantity)
        throw invalid("Serialized receipt requires one serial per unit");
      for (const serialNumber of serials)
        await InventoryUnit.create(
          [
            {
              variant: variantId,
              serialNumber,
              location: locationId,
              condition,
              inspectionState: "PASSED",
              state: "SELLABLE",
              sourceReference: po._id.toString(),
            },
          ],
          { session },
        );
      line.receivedQuantity += quantity;
      po.status = po.lines.every(
        (item) => item.receivedQuantity >= item.quantity,
      )
        ? "CLOSED"
        : "RECEIVING";
      await po.save({ session });
      await recordStockMovement(variantId, quantity, "restock", actor, session);
      await writeAuditLog(
        actor,
        "PURCHASE_ORDER_RECEIVED",
        "PurchaseOrder",
        po._id,
        { quantity, status: po.status },
        session,
      );
      result = po;
    });
    return result;
  } finally {
    await session.endSession();
  }
};
