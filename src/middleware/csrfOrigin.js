import AppError from "../utils/AppError.js";
import {
  parseOriginHeader,
  parseRefererOrigin,
  parseTrustedOrigins,
} from "../config/trustedOrigins.js";

export const protectCookieAuth = (req, res, next) => {
  const origin = req.get("origin");
  const referer = req.get("referer");
  if (!origin && !referer) {
    return next();
  }

  let candidate;
  try {
    candidate = origin ? parseOriginHeader(origin) : parseRefererOrigin(referer);
  } catch {
    return next(new AppError("Request origin is not allowed", 403, [{
      code: "untrusted_origin",
      message: "Use a trusted frontend origin",
    }]));
  }

  if (!parseTrustedOrigins().has(candidate)) {
    return next(new AppError("Request origin is not allowed", 403, [{
      code: "untrusted_origin",
      message: "Use a trusted frontend origin",
    }]));
  }
  return next();
};
