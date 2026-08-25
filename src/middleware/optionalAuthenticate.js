import { verifyAccessToken } from "../services/tokenService.js";

// Tracking must not reveal whether a malformed bearer credential was supplied.
export function optionalAccessAuthentication(req, res, next) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    try {
      const decoded = verifyAccessToken(header.slice(7));
      req.user = { id: decoded.userId, role: decoded.role };
    } catch {
      // The tracking service emits the same non-enumerating response for this case.
    }
  }
  next();
}
