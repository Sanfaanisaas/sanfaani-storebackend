import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const limiterMessage = (message, code) => ({
  success: false,
  message,
  errors: [{ code, message }],
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage(
    "Too many authentication attempts, please try again later",
    "auth_rate_limited",
  ),
  keyGenerator: (req) => {
    const ip = ipKeyGenerator(req.ip);
    if (req.path === "/login" && req.body?.email) {
      return `${ip}:${String(req.body.email).trim().toLowerCase()}`;
    }
    return ip;
  },
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many refresh attempts, please try again later", "refresh_rate_limited"),
});

export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many payment attempts, please try again later", "payment_rate_limited"),
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
});

export const refundInitiationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many refund requests, please try again later", "refund_rate_limited"),
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
});

export const repairTrackingRotationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many tracking-token rotations, please try again later", "repair_tracking_rotation_rate_limited"),
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
});

export const repairTrackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many repair tracking requests, please try again later", "repair_tracking_rate_limited"),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
});

// A new repair returns its tracking token exactly once, so token issuance is
// protected separately from read-only tracking requests and owner rotations.
export const repairTrackingIssuanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many tracking-token issuance requests, please try again later", "repair_tracking_issuance_rate_limited"),
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
});

export const evidenceUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many evidence uploads, please try again later", "evidence_upload_rate_limited"),
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
});

export const evidenceDownloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage("Too many evidence download requests, please try again later", "evidence_download_rate_limited"),
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
});
