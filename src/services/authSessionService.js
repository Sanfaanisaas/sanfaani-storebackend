import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import AuthSession from "../models/AuthSession.js";
import RefreshToken from "../models/RefreshToken.js";
import User from "../models/User.js";
import {
  REFRESH_TOKEN_MAX_AGE_MS,
  digestRefreshToken,
  generateRefreshToken,
  refreshTokenDigestMatches,
} from "./tokenService.js";
import { requestSecurityContext } from "./securityAuditService.js";

let testHooks = {};
export const setAuthSessionTestHooks = (hooks = {}) => { testHooks = hooks; };

export class RefreshSessionError extends Error {
  constructor(code = "refresh_token_invalid", reuse = false) {
    super(code);
    this.code = code;
    this.reuse = reuse;
  }
}

const tokenTimes = () => {
  const issuedAt = new Date();
  return { issuedAt, expiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_MAX_AGE_MS) };
};

const buildGeneration = ({ userId, sessionId, familyId, jti = randomUUID() }) => {
  const { issuedAt, expiresAt } = tokenTimes();
  const token = generateRefreshToken({ userId: String(userId), sessionId, familyId, jti });
  return {
    token,
    record: {
      jti, sessionId, familyId, user: userId,
      tokenDigest: digestRefreshToken(token), issuedAt, expiresAt,
    },
  };
};

export const createLoginSession = async (user, req) => {
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const generation = buildGeneration({ userId: user._id, sessionId, familyId });
  const context = requestSecurityContext(req);
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      await testHooks.beforeLoginPersistence?.();
      await AuthSession.create([{
        sessionId,
        familyId,
        user: user._id,
        currentJti: generation.record.jti,
        expiresAt: generation.record.expiresAt,
        deviceLabel: context.deviceLabel,
        createdIpDigest: context.ipDigest,
        lastUsedIpDigest: context.ipDigest,
      }], { session: dbSession });
      await RefreshToken.create([generation.record], { session: dbSession });
    });
  } finally {
    await dbSession.endSession();
  }
  return { refreshToken: generation.token, sessionId, expiresAt: generation.record.expiresAt };
};

export const revokeFamily = async (familyId, reason, at = new Date()) => {
  if (!familyId) return;
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      await AuthSession.updateMany(
        { familyId, revokedAt: null },
        { $set: { revokedAt: at, revocationReason: reason } },
        { session: dbSession },
      );
      await RefreshToken.updateMany(
        { familyId, status: { $ne: "revoked" } },
        { $set: { status: "revoked", revokedAt: at, revocationReason: reason } },
        { session: dbSession },
      );
    });
  } finally {
    await dbSession.endSession();
  }
};

const assertClaims = (claims) => {
  for (const field of ["userId", "sessionId", "familyId", "jti"]) {
    if (typeof claims?.[field] !== "string" || !claims[field]) {
      throw new RefreshSessionError("refresh_token_invalid");
    }
  }
};

export const rotateRefreshSession = async ({ token, claims, req }) => {
  assertClaims(claims);
  const old = await RefreshToken.findOne({ jti: claims.jti }).select("+tokenDigest");
  if (!old) throw new RefreshSessionError("refresh_session_unknown");

  const claimsMatch = old.sessionId === claims.sessionId
    && old.familyId === claims.familyId
    && String(old.user) === claims.userId;
  if (!claimsMatch || !refreshTokenDigestMatches(token, old.tokenDigest)) {
    await revokeFamily(old.familyId, "refresh_token_reuse_detected");
    throw new RefreshSessionError("refresh_token_reuse_detected", true);
  }
  if (old.status !== "active" || old.revokedAt) {
    await revokeFamily(old.familyId, "refresh_token_reuse_detected");
    throw new RefreshSessionError("refresh_token_reuse_detected", true);
  }

  const accountSession = await AuthSession.findOne({ sessionId: claims.sessionId });
  if (!accountSession) throw new RefreshSessionError("refresh_session_unknown");
  if (accountSession.revokedAt || accountSession.familyId !== claims.familyId) {
    await revokeFamily(old.familyId, "refresh_token_reuse_detected");
    throw new RefreshSessionError("refresh_token_reuse_detected", true);
  }
  const user = await User.findById(claims.userId).select("+authVersion");
  if (!user || user.status !== "ACTIVE") {
    await revokeFamily(old.familyId, "user_no_longer_exists");
    throw new RefreshSessionError("refresh_user_missing");
  }

  const now = new Date();
  if (old.expiresAt <= now || accountSession.expiresAt <= now) {
    await revokeFamily(old.familyId, "refresh_token_expired", now);
    throw new RefreshSessionError("refresh_token_expired");
  }

  const successor = buildGeneration({
    userId: user._id,
    sessionId: old.sessionId,
    familyId: old.familyId,
  });
  const context = requestSecurityContext(req);
  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const consumed = await RefreshToken.findOneAndUpdate(
        { _id: old._id, status: "active", revokedAt: null, expiresAt: { $gt: now } },
        { $set: {
          status: "rotated", rotatedAt: now, lastUsedAt: now,
          replacedByJti: successor.record.jti,
        } },
        { session: dbSession, returnDocument: "after" },
      );
      if (!consumed) throw new RefreshSessionError("refresh_token_reuse_detected", true);
      await testHooks.beforeSuccessorPersistence?.();
      await RefreshToken.create([successor.record], { session: dbSession });
      const advanced = await AuthSession.findOneAndUpdate(
        { sessionId: old.sessionId, currentJti: old.jti, revokedAt: null },
        { $set: {
          currentJti: successor.record.jti,
          lastUsedAt: now,
          lastUsedIpDigest: context.ipDigest,
          expiresAt: successor.record.expiresAt,
        } },
        { session: dbSession, returnDocument: "after" },
      );
      if (!advanced) throw new RefreshSessionError("refresh_token_reuse_detected", true);
    });
  } catch (error) {
    if (error instanceof RefreshSessionError && error.reuse) {
      await revokeFamily(old.familyId, "refresh_token_reuse_detected");
      throw error;
    }
    // A write conflict means the generation was concurrently consumed.
    if (error?.errorLabels?.includes?.("TransientTransactionError") || error?.code === 112) {
      await revokeFamily(old.familyId, "refresh_token_reuse_detected");
      throw new RefreshSessionError("refresh_token_reuse_detected", true);
    }
    throw error;
  } finally {
    await dbSession.endSession();
  }

  return { user, refreshToken: successor.token, sessionId: old.sessionId };
};

export const revokeRecognizedToken = async ({ token, claims, reason }) => {
  assertClaims(claims);
  const record = await RefreshToken.findOne({ jti: claims.jti }).select("+tokenDigest");
  if (!record || !refreshTokenDigestMatches(token, record.tokenDigest)) return null;
  await revokeFamily(record.familyId, reason);
  return { user: record.user, sessionId: record.sessionId };
};

export const revokeUserSession = async ({ userId, sessionId, reason }) => {
  const accountSession = await AuthSession.findOne({ user: userId, sessionId });
  if (!accountSession) return null;
  await revokeFamily(accountSession.familyId, reason);
  return accountSession;
};

export const revokeAllUserSessions = async ({ userId, reason }) => {
  const now = new Date();
  const dbSession = await mongoose.startSession();
  let count = 0;
  try {
    await dbSession.withTransaction(async () => {
      const sessions = await AuthSession.find({ user: userId, revokedAt: null })
        .select("familyId").session(dbSession);
      count = sessions.length;
      const families = sessions.map(({ familyId }) => familyId);
      await AuthSession.updateMany(
        { user: userId, revokedAt: null },
        { $set: { revokedAt: now, revocationReason: reason } },
        { session: dbSession },
      );
      if (families.length) {
        await RefreshToken.updateMany(
          { familyId: { $in: families }, status: { $ne: "revoked" } },
          { $set: { status: "revoked", revokedAt: now, revocationReason: reason } },
          { session: dbSession },
        );
      }
    });
  } finally {
    await dbSession.endSession();
  }
  return count;
};

export const sessionDto = (session, currentSessionId) => ({
  id: session.sessionId,
  createdAt: session.createdAt,
  lastUsedAt: session.lastUsedAt,
  expiresAt: session.expiresAt,
  deviceLabel: session.deviceLabel,
  current: session.sessionId === currentSessionId,
  revoked: Boolean(session.revokedAt),
});
