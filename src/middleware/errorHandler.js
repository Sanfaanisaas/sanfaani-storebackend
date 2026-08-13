import * as Sentry from "@sentry/node";
import mongoose from "mongoose";
import { env } from "../config/env.js";

const errorDetail = (field, code, message) => ({ field, code, message });

const duplicateKeyDetails = (error) => {
  const field = Object.keys(error.keyPattern ?? error.keyValue ?? {})[0] || "field";
  return [errorDetail(field, "duplicate", `${field} must be unique`)];
};

const mongooseValidationDetails = (error) => Object.values(error.errors ?? {}).map(
  (detail) => errorDetail(
    detail.path || "document",
    detail.kind === "ObjectId" ? "invalid_identifier" : "validation",
    detail.kind === "ObjectId" ? `${detail.path} must be a valid identifier` : detail.message,
  ),
);

const classifyError = (error) => {
  if (error?.type === "entity.parse.failed" || (
    error instanceof SyntaxError && error.status === 400 && "body" in error
  )) {
    return {
      statusCode: 400,
      message: "Malformed JSON request body",
      errors: [errorDetail("body", "malformed_json", "Request body must contain valid JSON")],
    };
  }

  if (error?.code === 11000) {
    return {
      statusCode: 409,
      message: "A value is already in use",
      errors: duplicateKeyDetails(error),
    };
  }

  if (error instanceof mongoose.Error.CastError) {
    return {
      statusCode: 400,
      message: "Invalid identifier",
      errors: [errorDetail(error.path || "id", "invalid_identifier", "A valid identifier is required")],
    };
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return {
      statusCode: 400,
      message: "Validation failed",
      errors: mongooseValidationDetails(error),
    };
  }

  if (error.isOperational) {
    return {
      statusCode: error.statusCode || 500,
      message: error.message,
      errors: Array.isArray(error.errors) ? error.errors : [],
    };
  }

  return {
    statusCode: 500,
    message: "Something went very wrong!",
    errors: [],
  };
};

export const errorHandler = (error, req, res, next) => {
  const response = classifyError(error);

  if (env.sentryDsn) Sentry.captureException(error);
  if (response.statusCode >= 500) console.error("ERROR 💥", error);

  return res.status(response.statusCode).json({
    success: false,
    message: response.message,
    errors: response.errors,
  });
};
