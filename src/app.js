import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { isTrustedOrigin, parseTrustedOrigins } from "./config/trustedOrigins.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { normalizeErrorEnvelope } from "./middleware/errorEnvelope.js";
import AppError from "./utils/AppError.js";

import healthRoutes from "./routes/healthRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import productRoutes from "./routes/productRoutes.js";
import cartRoutes from "./routes/cartRoutes.js";
import checkoutRoutes from "./routes/checkoutRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import repairRoutes from "./routes/repairRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import warrantyRoutes from "./routes/warrantyRoutes.js";
import claimRoutes from "./routes/claimRoutes.js";
import supportTicketRoutes from "./routes/supportTicketRoutes.js";
import financeRoutes from "./routes/financeRoutes.js";
import evidenceRoutes from "./routes/evidenceRoutes.js";
import procurementRoutes from "./routes/procurementRoutes.js";
import guidanceRoutes from "./routes/guidanceRoutes.js";
import returnRoutes from "./routes/returnRoutes.js";
import notificationRoutes, { preferencesRouter } from "./routes/notificationRoutes.js";
import customerServicesRoutes from "./routes/customerServicesRoutes.js";
import maintenancePlanRoutes from "./routes/maintenancePlanRoutes.js";
import organisationRoutes from "./routes/organisationRoutes.js";
import staffIdentityRoutes from "./routes/staffIdentityRoutes.js";
import contentRoutes from "./routes/contentRoutes.js";

const app = express();
app.set("trust proxy", 1);
const trustedOrigins = parseTrustedOrigins();

// Global Middlewares
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (origin === undefined) return callback(null, true);
      try {
        return callback(null, isTrustedOrigin(origin, trustedOrigins));
      } catch {
        return callback(null, false);
      }
    },
    credentials: true,
    exposedHeaders: ["Idempotency-Replayed"],
  })
);

if (env.nodeEnv === "development") {
  app.use(morgan("dev"));
}

app.use(normalizeErrorEnvelope);

// Specific route that needs raw body MUST come before express.json()
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
app.use("/api/payments/paystack/webhook", express.raw({ type: "application/json" }));

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

// Routes
app.use("/api", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/evidence", evidenceRoutes);
app.use("/api/procurement", procurementRoutes);
app.use("/api/guidance", guidanceRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/repairs", repairRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/warranties", warrantyRoutes);
app.use("/api/claims", claimRoutes);
app.use("/api/support-tickets", supportTicketRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/notification-preferences", preferencesRouter);
app.use("/api/services", customerServicesRoutes);
app.use("/api/maintenance-plans", maintenancePlanRoutes);
app.use("/api/organisations", organisationRoutes);
app.use("/api/admin/staff", staffIdentityRoutes);
app.use("/api/content", contentRoutes);

// Handle unhandled routes
app.all("/*path", (req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// Global Error Handler
app.use(errorHandler);

export default app;
