import mongoose from "mongoose";
import { env } from "../config/env.js";
import { processPendingDeliveries } from "../services/notificationDeliveryService.js";

let exitCode = 0;
try {
  await mongoose.connect(env.mongoUri);
  const result = await processPendingDeliveries({ limit: Number(process.argv[2] || 50) });
  console.log(JSON.stringify(result));
} catch {
  exitCode = 1;
  console.error("Notification outbox processing failed");
} finally {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  process.exitCode = exitCode;
}
