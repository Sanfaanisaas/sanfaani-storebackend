import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { expireReservations } from "../services/reservationService.js";

const actorId = process.env.RESERVATION_EXPIRY_ACTOR_ID;
if (!mongoose.isObjectIdOrHexString(actorId)) {
  console.error("RESERVATION_EXPIRY_ACTOR_ID must be an audited system-user ObjectId");
  process.exitCode = 1;
} else {
  try {
    await connectDB();
    const result = await expireReservations(new Date(), actorId);
    console.log(JSON.stringify({ job: "expire-reservations", ...result }));
  } finally {
    await mongoose.disconnect();
  }
}
