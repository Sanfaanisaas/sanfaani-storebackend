import AppError from "../utils/AppError.js";

const configuredOrigins = () => new Set(
  (process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

export const protectCookieAuth = (req, res, next) => {
  const origin = req.get("origin");
  const referer = req.get("referer");
  let candidate = origin;
  if (!candidate && referer) {
    try { candidate = new URL(referer).origin; } catch { candidate = "invalid"; }
  }

  // Non-browser clients generally send neither header. Browser requests must
  // prove they came from an explicitly trusted frontend origin.
  if (candidate && !configuredOrigins().has(candidate.replace(/\/$/, ""))) {
    return next(new AppError("Request origin is not allowed", 403, [{
      code: "untrusted_origin",
      message: "Use a trusted frontend origin",
    }]));
  }
  next();
};
