import { createHash } from "node:crypto";
import mongoose from "mongoose";
import Variant from "../models/Variant.js";
import StockLedger from "../models/StockLedger.js";
import InventoryUnit from "../models/InventoryUnit.js";
import InventoryLocation from "../models/InventoryLocation.js";
import Evidence from "../models/Evidence.js";
import StockCount from "../models/StockCount.js";
import StockDiscrepancy from "../models/StockDiscrepancy.js";
import AppError from "../utils/AppError.js";
import { writeAuditLog } from "./auditService.js";
import { STOCK_MOVEMENT_REASON } from "../utils/constants.js";

const conflict = (code, message) =>
  new AppError(message, 409, [{ code, message }]);
const invalid = (code, message) =>
  new AppError(message, 400, [{ code, message }]);
const unavailable = (resource = "Inventory record") =>
  new AppError(`${resource} is unavailable`, 404, [
    { code: "inventory_unavailable", message: "Check the record reference and permissions" },
  ]);
const digestPayload = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const assertEvidence = async (evidenceId, session) => {
  const evidence = await Evidence.findOne({
    _id: evidenceId,
    retentionState: { $in: ["ACTIVE", "LEGAL_HOLD"] },
  }).session(session);
  if (!evidence)
    throw invalid("inventory_evidence_invalid", "Active retained evidence is required");
  return evidence;
};

export const assertLocalInventory = (variant, requestedQuantity) => {
  if (variant?.sourcing != null)
    throw new AppError(`Variant ${variant.sku || variant._id} is sourcing-only`, 400);
  if (!Number.isFinite(variant?.inStock) || variant.inStock < 0)
    throw new AppError(`Variant ${variant?.sku || variant?._id} has invalid local inventory`, 400);
  if (requestedQuantity !== undefined) {
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1)
      throw invalid("stock_quantity_invalid", "Requested quantity must be a positive integer");
    if (requestedQuantity > variant.inStock)
      throw conflict("stock_insufficient", `Insufficient stock for variant ${variant.sku || variant._id}`);
  }
};

/** Change stock, append one immutable ledger fact, and audit in one transaction. */
export const recordStockMovement = async (
  variantId,
  delta,
  reason,
  actorId,
  session,
  options = {},
) => {
  if (!session) throw new Error("Stock movements require a MongoDB session");
  if (!Number.isSafeInteger(delta) || delta === 0)
    throw invalid("stock_delta_invalid", "Stock movement delta must be a non-zero integer");
  if (!Object.values(STOCK_MOVEMENT_REASON).includes(reason))
    throw invalid("stock_reason_invalid", "Stock movement reason is invalid");
  const variant = await Variant.findById(variantId).session(session);
  if (!variant) throw unavailable("Variant");
  assertLocalInventory(variant, delta < 0 ? Math.abs(delta) : undefined);
  const query = { _id: variantId, sourcing: null, inStock: { $type: "number", $gte: 0 } };
  if (delta < 0) query.inStock.$gte = Math.abs(delta);
  const updatedVariant = await Variant.findOneAndUpdate(
    query,
    { $inc: { inStock: delta } },
    { returnDocument: "after", session, runValidators: true },
  );
  if (!updatedVariant)
    throw conflict("stock_conflict", "Stock changed before this operation completed");
  const [ledger] = await StockLedger.create([{
    variant: variantId,
    delta,
    reason,
    actor: actorId,
    resultingStock: updatedVariant.inStock,
    inventoryUnit: options.inventoryUnit || null,
    fromLocation: options.fromLocation || null,
    toLocation: options.toLocation || null,
    sourceType: options.sourceType || "Manual",
    sourceId: options.sourceId || null,
    idempotencyKey: options.idempotencyKey || null,
    requestDigest: options.requestDigest || null,
    note: options.note || null,
  }], { session });
  await writeAuditLog(
    actorId,
    "STOCK_MOVEMENT_RECORDED",
    "StockLedger",
    ledger._id,
    { delta, reason, resultingStock: updatedVariant.inStock, sourceType: ledger.sourceType },
    session,
  );
  return { variant: updatedVariant, ledger };
};

export const recordInventoryUnitMovement = async ({ unit, reason, actor, fromLocation, toLocation, idempotencyKey, requestDigest, note, session }) => {
  const variant = await Variant.findById(unit.variant).session(session);
  if (!variant) throw unavailable("Variant");
  assertLocalInventory(variant);
  const [ledger] = await StockLedger.create([{
    variant: unit.variant,
    delta: 0,
    reason,
    actor,
    resultingStock: variant.inStock,
    inventoryUnit: unit._id,
    fromLocation,
    toLocation,
    sourceType: "InventoryUnit",
    sourceId: unit._id,
    idempotencyKey,
    requestDigest,
    note,
  }], { session });
  await writeAuditLog(
    actor,
    "STOCK_MOVEMENT_RECORDED",
    "StockLedger",
    ledger._id,
    { delta: 0, reason, resultingStock: variant.inStock, sourceType: "InventoryUnit" },
    session,
  );
  return { variant, ledger };
};

export const transitionInventoryUnit = async ({ unitId, action, actor, reason, evidenceId, idempotencyKey, toLocationId }) => {
  const requestDigest = digestPayload({ unitId, action, reason, evidenceId, toLocationId: toLocationId || null });
  const prior = await StockLedger.findOne({ idempotencyKey });
  if (prior) {
    if (prior.requestDigest !== requestDigest)
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    return { unit: await InventoryUnit.findById(prior.inventoryUnit), ledger: prior, replayed: true };
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await assertEvidence(evidenceId, session);
      const unit = await InventoryUnit.findById(unitId).session(session);
      if (!unit) throw unavailable("Inventory unit");
      let nextState = unit.state;
      let allowedStates;
      let movementReason;
      let delta = 0;
      let destination = unit.location;
      if (action === "transfer") {
        allowedStates = ["SELLABLE", "QUARANTINED", "RETURNED"];
        movementReason = STOCK_MOVEMENT_REASON.TRANSFER;
        if (!toLocationId || String(toLocationId) === String(unit.location))
          throw invalid("inventory_location_invalid", "A different destination location is required");
        if (!(await InventoryLocation.exists({ _id: toLocationId, active: true }).session(session)))
          throw invalid("inventory_location_invalid", "An active destination location is required");
        destination = toLocationId;
      } else if (action === "return-to-stock") {
        allowedStates = ["RETURNED"];
        movementReason = STOCK_MOVEMENT_REASON.RETURN;
        nextState = "SELLABLE";
        delta = 1;
      } else if (action === "release-quarantine") {
        allowedStates = ["QUARANTINED"];
        movementReason = STOCK_MOVEMENT_REASON.QUARANTINE_RELEASE;
        nextState = "SELLABLE";
        delta = 1;
      } else {
        throw invalid("inventory_action_invalid", "Inventory-unit action is invalid");
      }
      if (!allowedStates.includes(unit.state))
        throw conflict("inventory_unit_state_conflict", "Inventory unit is no longer eligible for this operation");
      if (delta > 0 && unit.inspectionState !== "PASSED")
        throw conflict("inventory_inspection_required", "A passed inspection is required before release");
      const updated = await InventoryUnit.findOneAndUpdate(
        { _id: unit._id, state: unit.state, location: unit.location },
        { $set: { state: nextState, location: destination, lastMovementAt: new Date(), lastMovementBy: actor } },
        { returnDocument: "after", session, runValidators: true },
      );
      if (!updated)
        throw conflict("inventory_unit_state_conflict", "Inventory unit changed before this operation completed");
      const movementOptions = {
        inventoryUnit: unit._id,
        fromLocation: unit.location,
        toLocation: destination,
        sourceType: "InventoryUnit",
        sourceId: unit._id,
        idempotencyKey,
        requestDigest,
        note: reason,
      };
      const movement = delta === 0
        ? await recordInventoryUnitMovement({ unit, reason: movementReason, actor, fromLocation: unit.location, toLocation: destination, idempotencyKey, requestDigest, note: reason, session })
        : await recordStockMovement(unit.variant, delta, movementReason, actor, session, movementOptions);
      await writeAuditLog(
        actor,
        "INVENTORY_UNIT_TRANSITIONED",
        "InventoryUnit",
        unit._id,
        { action, reason, evidenceId: String(evidenceId), fromState: unit.state, toState: nextState },
        session,
      );
      result = { unit: updated, ledger: movement.ledger, replayed: false };
    });
    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await StockLedger.findOne({ idempotencyKey });
      if (winner?.requestDigest === requestDigest)
        return { unit: await InventoryUnit.findById(winner.inventoryUnit), ledger: winner, replayed: true };
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const adjustStock = async ({ variantId, delta, reason, note, evidenceId, actor, idempotencyKey }) => {
  const requestDigest = digestPayload({ variantId, delta, reason, note, evidenceId });
  const prior = await StockLedger.findOne({ idempotencyKey });
  if (prior) {
    if (prior.requestDigest !== requestDigest)
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    return { ledger: prior, variant: await Variant.findById(prior.variant), replayed: true };
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await assertEvidence(evidenceId, session);
      result = await recordStockMovement(variantId, delta, reason, actor, session, {
        sourceType: "Manual", idempotencyKey, requestDigest, note,
      });
      result.replayed = false;
    });
    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await StockLedger.findOne({ idempotencyKey });
      if (winner?.requestDigest === requestDigest)
        return { ledger: winner, variant: await Variant.findById(winner.variant), replayed: true };
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const createStockCount = async ({ variantId, locationId, countedQuantity, reason, evidenceId, actor, idempotencyKey }) => {
  const requestDigest = digestPayload({ variantId, locationId, countedQuantity, reason, evidenceId });
  const existing = await StockCount.findOne({ idempotencyKey });
  if (existing) {
    if (existing.requestDigest !== requestDigest)
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    return existing;
  }
  const session = await mongoose.startSession();
  try {
    let count;
    await session.withTransaction(async () => {
      // MongoDB sessions do not support parallel operations inside one
      // transaction; resolve the two controlled reads sequentially.
      const variant = await Variant.findById(variantId).session(session);
      const location = await InventoryLocation.findOne({
        _id: locationId,
        active: true,
      }).session(session);
      if (!variant || !location) throw unavailable();
      assertLocalInventory(variant);
      await assertEvidence(evidenceId, session);
      const expectedQuantity = variant.inStock;
      const status = expectedQuantity === countedQuantity ? "MATCHED" : "DISCREPANCY";
      [count] = await StockCount.create([{
        variant: variantId,
        location: locationId,
        expectedQuantity,
        countedQuantity,
        status,
        reason,
        evidence: evidenceId,
        createdBy: actor,
        idempotencyKey,
        requestDigest,
        countScope: "VARIANT_GLOBAL",
      }], { session });
      if (status === "DISCREPANCY") {
        const [discrepancy] = await StockDiscrepancy.create([{
          stockCount: count._id,
          variant: variantId,
          location: locationId,
          expectedQuantity,
          countedQuantity,
          variance: countedQuantity - expectedQuantity,
        }], { session });
        count.discrepancy = discrepancy._id;
        await count.save({ session });
      }
      await writeAuditLog(
        actor,
        "STOCK_COUNT_RECORDED",
        "StockCount",
        count._id,
        { expectedQuantity, countedQuantity, status, reason, evidenceId: String(evidenceId) },
        session,
      );
    });
    return count;
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await StockCount.findOne({ idempotencyKey });
      if (winner?.requestDigest === requestDigest) return winner;
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

export const listStockCounts = async ({ page = 1, limit = 20, status }) => {
  const query = status ? { status } : {};
  const [items, total] = await Promise.all([
    StockCount.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    StockCount.countDocuments(query),
  ]);
  return { items, page, limit, total };
};

export const listStockDiscrepancies = async ({ page = 1, limit = 20, status }) => {
  const query = status ? { status } : {};
  const [items, total] = await Promise.all([
    StockDiscrepancy.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    StockDiscrepancy.countDocuments(query),
  ]);
  return { items, page, limit, total };
};

export const resolveStockDiscrepancy = async ({ discrepancyId, resolution, resolutionReason, evidenceId, actor, idempotencyKey }) => {
  const resolutionDigest = digestPayload({ discrepancyId, resolution, resolutionReason, evidenceId });
  const prior = await StockDiscrepancy.findOne({ resolutionIdempotencyKey: idempotencyKey });
  if (prior) {
    if (prior.resolutionRequestDigest !== resolutionDigest)
      throw conflict("idempotency_conflict", "Idempotency key was already used with different input");
    return prior;
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await assertEvidence(evidenceId, session);
      const discrepancy = await StockDiscrepancy.findOne({ _id: discrepancyId, status: "OPEN" }).session(session);
      if (!discrepancy) {
        const resolved = await StockDiscrepancy.findById(discrepancyId).session(session);
        if (resolved?.status === "RESOLVED")
          throw conflict("stock_discrepancy_resolved", "Stock discrepancy was already resolved");
        throw unavailable("Stock discrepancy");
      }
      if (resolution === "ADJUST_STOCK" && discrepancy.variance !== 0) {
        await recordStockMovement(
          discrepancy.variant,
          discrepancy.variance,
          STOCK_MOVEMENT_REASON.COUNT_RECONCILIATION,
          actor,
          session,
          {
            fromLocation: discrepancy.location,
            toLocation: discrepancy.location,
            sourceType: "StockDiscrepancy",
            sourceId: discrepancy._id,
            idempotencyKey,
            requestDigest: resolutionDigest,
            note: resolutionReason,
          },
        );
      }
      discrepancy.status = "RESOLVED";
      discrepancy.resolution = resolution;
      discrepancy.resolutionReason = resolutionReason;
      discrepancy.resolutionEvidence = evidenceId;
      discrepancy.resolvedBy = actor;
      discrepancy.resolvedAt = new Date();
      discrepancy.resolutionIdempotencyKey = idempotencyKey;
      discrepancy.resolutionRequestDigest = resolutionDigest;
      await discrepancy.save({ session });
      await StockCount.updateOne(
        { _id: discrepancy.stockCount, status: "DISCREPANCY" },
        { $set: { status: "RECONCILED" } },
        { session },
      );
      await writeAuditLog(
        actor,
        "STOCK_DISCREPANCY_RESOLVED",
        "StockDiscrepancy",
        discrepancy._id,
        { resolution, variance: discrepancy.variance, reason: resolutionReason, evidenceId: String(evidenceId) },
        session,
      );
      result = discrepancy;
    });
    return result;
  } catch (error) {
    if (error?.code === 11000 || error?.errors?.some?.((item) => item.code === "stock_discrepancy_resolved")) {
      const winner = await StockDiscrepancy.findOne({ resolutionIdempotencyKey: idempotencyKey });
      if (winner?.resolutionRequestDigest === resolutionDigest) return winner;
    }
    throw error;
  } finally {
    await session.endSession();
  }
};
