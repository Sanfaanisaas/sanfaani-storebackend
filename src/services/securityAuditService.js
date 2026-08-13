import { createHmac } from "node:crypto";
import { env } from "../config/env.js";
import SecurityAuditEvent from "../models/SecurityAuditEvent.js";

const reasonPolicies = {
  login_failed: new Set(["invalid_credentials", "session_persistence_failed"]),
  refresh_failed: new Set([
    "missing_cookie",
    "expired",
    "invalid",
    "persistence_failed",
    "refresh_token_invalid",
    "refresh_session_unknown",
    "refresh_user_missing",
    "refresh_token_expired",
  ]),
  refresh_reuse_detected: new Set(["refresh_token_reuse_detected"]),
};

export const SECURITY_AUDIT_EVENTS = new Set([
  "login_succeeded",
  "login_failed",
  "refresh_succeeded",
  "refresh_failed",
  "refresh_reuse_detected",
  "logout",
  "session_revoked",
  "all_sessions_revoked",
]);

const allowedMetadataKeys = {
  login_succeeded: new Set(),
  login_failed: new Set(["reason"]),
  refresh_succeeded: new Set(),
  refresh_failed: new Set(["reason"]),
  refresh_reuse_detected: new Set(["reason"]),
  logout: new Set(),
  session_revoked: new Set(),
  all_sessions_revoked: new Set(["count"]),
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

export const sanitizeSecurityAuditMetadata = (event, metadata = {}) => {
  if (!SECURITY_AUDIT_EVENTS.has(event)) throw new TypeError("Unsupported security audit event");
  if (!isPlainObject(metadata)) throw new TypeError("Audit metadata must be a plain object");

  const keys = Reflect.ownKeys(metadata);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Audit metadata keys must be strings");
  }

  const allowed = allowedMetadataKeys[event];
  if (keys.some((key) => !allowed.has(key))) {
    throw new TypeError("Audit metadata contains an unexpected field");
  }

  if (keys.includes("reason")) {
    const reason = metadata.reason;
    if (typeof reason !== "string" || reason.length > 80 || !reasonPolicies[event]?.has(reason)) {
      throw new TypeError("Audit reason is not allowlisted");
    }
  }

  if (keys.includes("count")) {
    const count = metadata.count;
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      throw new TypeError("Audit count is outside the allowed range");
    }
  }

  return Object.fromEntries(keys.map((key) => [key, metadata[key]]));
};

export const digestAuditIp = (ip, key = env.securityAuditHmacSecret) => {
  if (typeof ip !== "string" || !ip) return null;
  if (typeof key !== "string" || key.length < 32) {
    throw new TypeError("A 32+ character audit HMAC key is required");
  }
  return createHmac("sha256", key).update(ip, "utf8").digest("hex");
};

export const requestSecurityContext = (req) => ({
  ipDigest: digestAuditIp(typeof req.ip === "string" ? req.ip : ""),
  deviceLabel: (() => {
    const header = req.get("user-agent");
    const agent = typeof header === "string" ? header.slice(0, 512) : "";
    const browser = /Edg\//.test(agent) ? "Edge"
      : /Firefox\//.test(agent) ? "Firefox"
        : /Chrome\//.test(agent) ? "Chrome"
          : /Safari\//.test(agent) ? "Safari" : "Unknown browser";
    const platform = /Android/.test(agent) ? "Android"
      : /iPhone|iPad/.test(agent) ? "iOS"
        : /Windows/.test(agent) ? "Windows"
          : /Mac OS/.test(agent) ? "macOS"
            : /Linux/.test(agent) ? "Linux" : "Unknown device";
    return `${browser} on ${platform}`;
  })(),
});

// Audit is deliberately fail-open: authentication state remains authoritative;
// write failures are reported without request/token material for later recovery.
export const recordSecurityEvent = async ({ event, user, sessionId, req, metadata }) => {
  try {
    if (!SECURITY_AUDIT_EVENTS.has(event)) throw new TypeError("Unsupported security audit event");
    const context = req ? requestSecurityContext(req) : {};
    await SecurityAuditEvent.create({
      event,
      user: user || null,
      sessionId: sessionId || null,
      ipDigest: context.ipDigest || null,
      metadata: sanitizeSecurityAuditMetadata(event, metadata),
    });
  } catch {
    console.error("Security audit event could not be persisted", {
      event: SECURITY_AUDIT_EVENTS.has(event) ? event : "invalid_event",
    });
  }
};
