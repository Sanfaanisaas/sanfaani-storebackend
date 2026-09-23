import AppError from "../utils/AppError.js";
import {
  parseOriginHeader,
  parseRefererOrigin,
  parseTrustedOrigins,
} from "../config/trustedOrigins.js";
import { REFRESH_COOKIE_NAME } from "../utils/refreshCookie.js";

export const protectCookieAuth = (req, res, next) => {
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const hasRefreshCookie = Boolean(req.cookies?.[REFRESH_COOKIE_NAME]);
  const hasBearerToken = req.get("authorization")?.startsWith("Bearer ");
  const cookieAuthenticated = hasRefreshCookie && !hasBearerToken;
  const origin = req.get("origin");
  const referer = req.get("referer");
  if (!unsafeMethod || (!cookieAuthenticated && !origin && !referer)) {
    return next();
  }
  if (cookieAuthenticated && !origin && !referer) {
    return next(new AppError("Request origin is not allowed", 403, [{
      code: "untrusted_origin",
      message: "Use a trusted frontend origin",
    }]));
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
