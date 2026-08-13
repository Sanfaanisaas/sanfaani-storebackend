import { createHash } from "node:crypto";
import SecurityAuditEvent from "../models/SecurityAuditEvent.js";

const forbidden = /token|cookie|password|authorization|secret|hash/i;
const cleanMetadata = (metadata = {}) => Object.fromEntries(
  Object.entries(metadata)
    .filter(([key]) => !forbidden.test(key))
    .slice(0, 12)
    .map(([key, value]) => [key, String(value).slice(0, 200)]),
);

export const requestSecurityContext = (req) => ({
  ipDigest: req.ip
    ? createHash("sha256").update(req.ip).digest("hex")
    : null,
  deviceLabel: (() => {
    const agent = String(req.get("user-agent") || "");
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
  ip: String(req.ip || "").slice(0, 80),
});

// Audit is deliberately fail-open: authentication state remains authoritative;
// write failures are reported without request/token material for later recovery.
export const recordSecurityEvent = async ({ event, user, sessionId, req, metadata }) => {
  try {
    const context = req ? requestSecurityContext(req) : {};
    await SecurityAuditEvent.create({
      event,
      user: user || null,
      sessionId: sessionId || null,
      ipDigest: context.ipDigest || null,
      metadata: cleanMetadata(metadata),
    });
  } catch {
    console.error("Security audit event could not be persisted", { event });
  }
};
