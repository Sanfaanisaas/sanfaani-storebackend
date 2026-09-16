import mongoose from "mongoose";
import { env } from "../config/env.js";

const required = ["mongoUri", "jwtSecret", "jwtRefreshSecret", "securityAuditHmacSecret", "paystackSecretKey", "pushTokenEncryptionKey"];
export const readiness = () => {
  const missing = required.filter((key) => !env[key]);
  const mongoReady = mongoose.connection.readyState === 1;
  return { ready: mongoReady && missing.length === 0, dependencies: { mongo: mongoReady ? "ready" : "unavailable", configuration: missing.length ? "invalid" : "ready" } };
};
