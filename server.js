import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./src/config/env.js";
import { connectDB } from "./src/config/db.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import healthRoutes from "./src/routes/healthRoutes.js";
import authRoutes from "./src/routes/authRoutes.js";

const app = express();

// Core middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Routes
app.use("/api", healthRoutes);
app.use("/api/auth", authRoutes);

// 404 handler — catches any route that didn't match above
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Global error handler — must be registered last
app.use(errorHandler);

// Connect to DB, then start server
connectDB().then(() => {
  app.listen(env.port, () => {
    console.log(`🚀 Server running on http://localhost:${env.port}`);
  });
});