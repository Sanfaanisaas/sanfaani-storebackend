import * as Sentry from "@sentry/node";
import { env } from "../config/env.js";

const DUPLICATE_FIELDS = new Set(["slug", "sku"]);

const duplicateField = (error) => {
  const key = Object.keys(error.keyPattern ?? error.keyValue ?? {})[0];
  return DUPLICATE_FIELDS.has(key) ? key : "field";
};

const isDuplicateKey = (error) => error?.code === 11000;

const sendDuplicateKey = (error, res) => {
  const field = duplicateField(error);
  return res.status(409).json({
    success: false,
    message: "A catalogue value is already in use",
    errors: [{ field, code: "duplicate", message: `${field} must be unique` }],
  });
};

const sendErrorDev = (error, res) => {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errors: error.errors || null,
    stack: error.stack,
  });
};

const sendErrorProd = (error, res) => {
  if (error.isOperational) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      errors: error.errors || null,
    });
  }

  console.error("ERROR 💥", error);
  return res.status(500).json({
    success: false,
    message: "Something went very wrong!",
    errors: null,
  });
};

export const errorHandler = (error, req, res, next) => {
  if (isDuplicateKey(error)) return sendDuplicateKey(error, res);

  error.statusCode = error.statusCode || 500;
  error.status = error.status || "error";

  if (env.sentryDsn) Sentry.captureException(error);

  if (env.nodeEnv === "development") return sendErrorDev(error, res);
  return sendErrorProd(error, res);
};
