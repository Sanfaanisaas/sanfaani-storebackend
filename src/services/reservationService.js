import mongoose from "mongoose";
import StockReservation from "../models/StockReservation.js";
import { recordStockMovement } from "./inventoryService.js";

export const releaseReservation = async (reservationId, actorId, reason, session) => {
  const reservation = await StockReservation.findOneAndUpdate(
    { _id: reservationId, status: { $in: ["RESERVED", "ALLOCATED"] } },
    { $set: { status: "RELEASED", releasedAt: new Date(), releaseReason: reason } },
    { returnDocument: "after", session },
  );
  if (!reservation) return null;
  await recordStockMovement(reservation.variant, reservation.quantity, "return", actorId, session);
  return reservation;
};

export const consumeReservation = async (reservationId, session) => StockReservation.findOneAndUpdate(
  { _id: reservationId, status: "ALLOCATED" },
  { $set: { status: "CONSUMED", consumedAt: new Date() } },
  { returnDocument: "after", session },
);

export const expireReservations = async (now = new Date(), systemActorId) => {
  if (!systemActorId) throw new Error("A recorded system actor is required for reservation expiry");
  const session = await mongoose.startSession();
  try {
    let released = 0;
    await session.withTransaction(async () => {
      const reservations = await StockReservation.find({ status: "RESERVED", expiresAt: { $lte: now } }).session(session);
      for (const reservation of reservations) if (await releaseReservation(reservation._id, systemActorId, "payment_expired", session)) released += 1;
    });
    return { released };
  } finally { await session.endSession(); }
};
