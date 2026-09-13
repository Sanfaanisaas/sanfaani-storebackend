import mongoose from "mongoose";
import StockReservation from "../models/StockReservation.js";
import Order from "../models/Order.js";
import AppError from "../utils/AppError.js";
import { ORDER_STATUS, STOCK_MOVEMENT_REASON } from "../utils/constants.js";
import { recordStockMovement } from "./inventoryService.js";
import { writeAuditLog } from "./auditService.js";

export const RESERVATION_TTL_MS = 15 * 60 * 1000;
const conflict = (code, message) =>
  new AppError(message, 409, [{ code, message }]);
const unavailable = () =>
  new AppError("Order information is unavailable", 404, [
    {
      code: "order_unavailable",
      message: "Check the order reference and permissions",
    },
  ]);

export const createReservation = async ({
  order,
  product,
  variant,
  quantity,
  actorId,
  session,
  expiresAt = new Date(Date.now() + RESERVATION_TTL_MS),
}) => {
  await recordStockMovement(
    variant,
    -quantity,
    STOCK_MOVEMENT_REASON.SALE,
    actorId,
    session,
  );
  const [reservation] = await StockReservation.create(
    [
      {
        order,
        product,
        variant,
        quantity,
        status: "RESERVED",
        reservedAt: new Date(),
        expiresAt,
      },
    ],
    { session },
  );
  await writeAuditLog(
    actorId,
    "INVENTORY_RESERVED",
    "StockReservation",
    reservation._id,
    { orderId: order.toString(), quantity },
    session,
  );
  return reservation;
};

export const releaseReservation = async (
  reservationId,
  actorId,
  reason,
  session,
  { expired = false } = {},
) => {
  const nextStatus = expired ? "EXPIRED" : "RELEASED";
  const reservation = await StockReservation.findOneAndUpdate(
    { _id: reservationId, status: { $in: ["RESERVED", "ALLOCATED"] } },
    {
      $set: {
        status: nextStatus,
        releasedAt: new Date(),
        releaseReason: reason,
      },
    },
    { returnDocument: "after", session },
  );
  if (!reservation) return null;
  await recordStockMovement(
    reservation.variant,
    reservation.quantity,
    STOCK_MOVEMENT_REASON.RETURN,
    actorId,
    session,
  );
  await writeAuditLog(
    actorId,
    expired
      ? "INVENTORY_RESERVATION_EXPIRED"
      : "INVENTORY_RESERVATION_RELEASED",
    "StockReservation",
    reservation._id,
    {
      orderId: reservation.order.toString(),
      quantity: reservation.quantity,
      reason,
    },
    session,
  );
  return reservation;
};

export const allocateOrderReservations = async (orderId, actorId, session) => {
  const reservations = await StockReservation.find({
    order: orderId,
    status: "RESERVED",
  }).session(session);
  for (const reservation of reservations) {
    reservation.status = "ALLOCATED";
    reservation.allocatedAt = new Date();
    await reservation.save({ session });
    await writeAuditLog(
      actorId,
      "INVENTORY_ALLOCATED",
      "StockReservation",
      reservation._id,
      { orderId: orderId.toString(), quantity: reservation.quantity },
      session,
    );
  }
  return reservations;
};

export const releaseOrderReservations = async (
  orderId,
  actorId,
  reason,
  session,
  options,
) => {
  const reservations = await StockReservation.find({
    order: orderId,
    status: { $in: ["RESERVED", "ALLOCATED"] },
  }).session(session);
  let released = 0;
  for (const reservation of reservations)
    if (
      await releaseReservation(
        reservation._id,
        actorId,
        reason,
        session,
        options,
      )
    )
      released += 1;
  return released;
};

export const cancelOrderWithReservations = async ({
  orderId,
  ownerId,
  actorId,
  actorRole,
}) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      const query =
        actorRole === "customer"
          ? { _id: orderId, userId: ownerId }
          : { _id: orderId };
      order = await Order.findOne(query).session(session);
      if (!order) throw unavailable();
      if (order.status === ORDER_STATUS.CANCELLED) return;
      if (
        [
          ORDER_STATUS.DISPATCHED,
          ORDER_STATUS.DELIVERED,
          ORDER_STATUS.COMPLETED,
        ].includes(order.status)
      )
        throw conflict(
          "order_cancellation_unavailable",
          "This fulfilled order cannot be cancelled",
        );
      await releaseOrderReservations(
        order._id,
        actorId,
        "order_cancelled",
        session,
      );
      order.status = ORDER_STATUS.CANCELLED;
      if (order.paymentStatus === "pending") order.paymentStatus = "failed";
      await order.save({ session });
      await writeAuditLog(
        actorId,
        "ORDER_CANCELLED",
        "Order",
        order._id,
        { actorRole },
        session,
      );
    });
    return order;
  } finally {
    await session.endSession();
  }
};

export const expireReservations = async (now = new Date(), systemActorId) => {
  if (!systemActorId)
    throw new Error(
      "A recorded system actor is required for reservation expiry",
    );
  const session = await mongoose.startSession();
  try {
    let released = 0;
    await session.withTransaction(async () => {
      const reservations = await StockReservation.find({
        status: "RESERVED",
        expiresAt: { $lte: now },
      }).session(session);
      for (const reservation of reservations)
        if (
          await releaseReservation(
            reservation._id,
            systemActorId,
            "payment_expired",
            session,
            { expired: true },
          )
        )
          released += 1;
    });
    return { released };
  } finally {
    await session.endSession();
  }
};

export const consumeOrderAllocations = async (
  order,
  actorId,
  serials = [],
  session,
) => {
  const reservations = await StockReservation.find({
    order: order._id,
    status: "ALLOCATED",
  }).session(session);
  if (!reservations.length)
    throw conflict(
      "order_allocation_unavailable",
      "Order inventory is not allocated or has already been consumed",
    );

  for (const reservation of reservations) {
    reservation.status = "CONSUMED";
    reservation.consumedAt = new Date();
    await reservation.save({ session });
    await writeAuditLog(
      actorId,
      "INVENTORY_ALLOCATION_CONSUMED",
      "StockReservation",
      reservation._id,
      { orderId: order._id.toString(), quantity: reservation.quantity },
      session,
    );
  }

  if (serials && serials.length > 0) {
    const InventoryUnit = mongoose.model("InventoryUnit");
    const units = await InventoryUnit.find({
      serialNumber: { $in: serials },
      state: { $in: ["SELLABLE", "ALLOCATED"] },
    }).session(session);

    if (units.length !== serials.length)
      throw conflict(
        "invalid_serials",
        "One or more serials are invalid, unavailable, or already consumed",
      );

    for (const unit of units) {
      unit.state = "CONSUMED";
      await unit.save({ session });
      await writeAuditLog(
        actorId,
        "INVENTORY_UNIT_CONSUMED",
        "InventoryUnit",
        unit._id,
        { orderId: order._id.toString(), serial: unit.serialNumber },
        session,
      );
    }
  }
};

export const fulfillOrder = async ({
  orderId,
  actorId,
  action,
  metadata = {},
}) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await Order.findById(orderId).session(session);
      if (!order) throw unavailable();

      const target =
        action === "dispatch"
          ? ORDER_STATUS.DISPATCHED
          : ORDER_STATUS.COMPLETED;
      if (order.status === target) return; // Idempotent success

      if (
        [ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED].includes(order.status)
      ) {
        throw conflict("order_state_invalid", "Order is in a terminal state");
      }
      if (order.paymentStatus !== "paid")
        throw conflict(
          "order_payment_gate",
          "Verified payment is required before fulfilment",
        );

      await consumeOrderAllocations(
        order,
        actorId,
        metadata.assignedSerials,
        session,
      );

      order.status = target;
      order.fulfilment = order.fulfilment || {};

      if (action === "dispatch") {
        order.fulfilment.dispatchedAt = new Date();
        if (metadata.trackingReference)
          order.fulfilment.trackingReference = metadata.trackingReference;
        if (metadata.courierName)
          order.fulfilment.courierName = metadata.courierName;
      } else if (action === "collect") {
        order.fulfilment.collectedAt = new Date();
        order.fulfilment.deliveredAt = new Date(); // Collection implies immediate delivery
        order.fulfilment.identityDocumentType = metadata.identityDocumentType;
        order.fulfilment.acknowledgedBy = metadata.acknowledgedBy;
      }

      if (metadata.assignedSerials?.length > 0 && order.items.length > 0) {
        order.items[0].assignedSerials = metadata.assignedSerials;
      }

      await order.save({ session });
      await writeAuditLog(
        actorId,
        action === "dispatch" ? "ORDER_DISPATCHED" : "ORDER_COLLECTED",
        "Order",
        order._id,
        { allocationState: "CONSUMED" },
        session,
      );
    });
    return order;
  } finally {
    await session.endSession();
  }
};

export const confirmDelivery = async ({ orderId, actorId }) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await Order.findById(orderId).session(session);
      if (!order) throw unavailable();
      if (order.status === ORDER_STATUS.COMPLETED) return; // Idempotent
      if (order.status !== ORDER_STATUS.DISPATCHED)
        throw conflict(
          "order_not_dispatched",
          "Order must be dispatched before confirming delivery",
        );

      order.status = ORDER_STATUS.COMPLETED;
      order.fulfilment = order.fulfilment || {};
      order.fulfilment.deliveredAt = new Date();

      await order.save({ session });
      await writeAuditLog(
        actorId,
        "ORDER_DELIVERED",
        "Order",
        order._id,
        {},
        session,
      );
    });
    return order;
  } finally {
    await session.endSession();
  }
};
