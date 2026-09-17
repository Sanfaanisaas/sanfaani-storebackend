import bcrypt from "bcryptjs";
import AuthSession from "../models/AuthSession.js";
import User from "../models/User.js";
import {
  createLoginSession,
  RefreshSessionError,
  revokeAllUserSessions,
  revokeRecognizedToken,
  revokeUserSession,
  rotateRefreshSession,
  sessionDto,
} from "../services/authSessionService.js";
import { recordSecurityEvent } from "../services/securityAuditService.js";
import {
  generateAccessToken,
  verifyRefreshToken,
  verifyRefreshTokenIgnoringExpiry,
} from "../services/tokenService.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from "../utils/refreshCookie.js";
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from "../utils/refreshCookie.js";
import { revokePushDeviceByIdentifier } from "../services/pushDeviceService.js";

export const PASSWORD_HASH_COST = 12;
export const DUMMY_PASSWORD_HASH =
  "$2b$12$STwmCXXAcG1juP88YSrvc.xvHyHZ6Kd.MLSEIDJg.cpO16B1PEc0K";

const fail = (res, message, code, detail = "Sign in again to continue") =>
  res.status(401).json({
    success: false,
    message,
    errors: [{ code, message: detail }],
  });

const cookieSessionId = (req) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) return null;
  try {
    return verifyRefreshTokenIgnoringExpiry(token).sessionId || null;
  } catch {
    return null;
  }
};

export const register = catchAsync(async (req, res) => {
  const { name, email, password, phone } = req.body;
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(409).json({
      success: false,
      message: "An account with this email already exists",
      errors: [{ code: "email_in_use", message: "Use another email address" }],
    });
  }
  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_COST);
  const user = await User.create({ name, email, passwordHash, phone });
  return res.status(201).json({ success: true, data: user.toSafeObject() });
});

export const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  const matches = await bcrypt.compare(
    password,
    user?.passwordHash || DUMMY_PASSWORD_HASH,
  );
  if (!user || !matches) {
    const user = await User.findOne({ email }).select("+authVersion");
    const matches = await bcrypt.compare(
      password,
      user?.passwordHash || DUMMY_PASSWORD_HASH,
    );
    if (!user || !matches || user.status !== "ACTIVE") {
      await recordSecurityEvent({
        event: "login_failed",
        user: user?._id,
        req,
        metadata: { reason: "invalid_credentials" },
      });
      return fail(
        res,
        "Invalid credentials",
        "invalid_credentials",
        "Email or password is incorrect",
      );
    }

    let created;
    try {
      created = await createLoginSession(user, req);
    } catch {
      await recordSecurityEvent({
        event: "login_failed",
        user: user._id,
        req,
        metadata: { reason: "session_persistence_failed" },
      });
      throw new AppError("Authentication service unavailable", 503, [
        {
          code: "session_persistence_failed",
          message: "Please try again later",
        },
      ]);
    }
    const accessToken = generateAccessToken(user);
    await recordSecurityEvent({
      event: "login_succeeded",
      user: user._id,
      sessionId: created.sessionId,
      req,
    });
    setRefreshCookie(res, created.refreshToken);
    return res.status(200).json({
      success: true,
      data: { accessToken, user: user.toSafeObject() },
    });
  }
});

export const refresh = catchAsync(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) {
    await recordSecurityEvent({
      event: "refresh_failed",
      req,
      metadata: { reason: "missing_cookie" },
    });
    return fail(
      res,
      "Refresh session required",
      "refresh_token_missing",
      "Sign in to continue",
    );
  }

  let claims;
  try {
    claims = verifyRefreshToken(token);
  } catch (error) {
    clearRefreshCookie(res);
    const expired = error?.name === "TokenExpiredError";
    await recordSecurityEvent({
      event: "refresh_failed",
      req,
      metadata: { reason: expired ? "expired" : "invalid" },
    });
    return fail(
      res,
      expired ? "Refresh session has expired" : "Refresh session is invalid",
      expired ? "refresh_token_expired" : "refresh_token_invalid",
    );
  }

  try {
    const rotated = await rotateRefreshSession({ token, claims, req });
    const accessToken = generateAccessToken(rotated.user);
    await recordSecurityEvent({
      event: "refresh_succeeded",
      user: rotated.user._id,
      sessionId: rotated.sessionId,
      req,
    });
    setRefreshCookie(res, rotated.refreshToken);
    return res.status(200).json({
      success: true,
      data: { accessToken, user: rotated.user.toSafeObject() },
    });
  } catch (error) {
    if (!(error instanceof RefreshSessionError)) {
      await recordSecurityEvent({
        event: "refresh_failed",
        user: claims.userId,
        sessionId: claims.sessionId,
        req,
        metadata: { reason: "persistence_failed" },
      });
      throw new AppError("Authentication service unavailable", 503, [
        {
          code: "refresh_persistence_failed",
          message: "Please try again later",
        },
      ]);
    }
    clearRefreshCookie(res);
    await recordSecurityEvent({
      event: error.reuse ? "refresh_reuse_detected" : "refresh_failed",
      user: claims.userId,
      sessionId: claims.sessionId,
      req,
      metadata: { reason: error.code },
    });
    if (error.reuse) {
      return fail(
        res,
        "Session is no longer valid",
        "refresh_token_reuse_detected",
      );
    }
    return fail(res, "Session is no longer valid", error.code);
  }
});

export const logout = catchAsync(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  clearRefreshCookie(res);
  let identified = null;
  if (token) {
    let claims;
    try {
      claims = verifyRefreshTokenIgnoringExpiry(token);
    } catch {
      claims = null;
    }
    if (claims) {
      try {
        identified = await revokeRecognizedToken({
          token,
          claims,
          reason: "logout",
        });
      } catch (error) {
        if (error instanceof RefreshSessionError) identified = null;
        else
          throw new AppError("Logout service unavailable", 503, [
            {
              code: "logout_persistence_failed",
              message: "The cookie was cleared; please try again later",
            },
          ]);
      }
    }
  }
  if (identified) {
    await recordSecurityEvent({
      event: "logout",
      user: identified.user,
      sessionId: identified.sessionId,
      req,
    });
  }
  return res
    .status(200)
    .json({ success: true, data: { message: "Logged out successfully" } });
  await revokePushDeviceByIdentifier({
    owner: identified?.user || req.user?.id,
    deviceId: req.get("X-Push-Device-Id"),
    reason: "logout",
  });
  return res
    .status(200)
    .json({ success: true, data: { message: "Logged out successfully" } });
});

export const listSessions = catchAsync(async (req, res) => {
  const sessions = await AuthSession.find({ user: req.user.id }).sort({
    createdAt: -1,
  });
  const currentSessionId = cookieSessionId(req);
  return res.status(200).json({
    success: true,
    data: {
      sessions: sessions.map((session) =>
        sessionDto(session, currentSessionId),
      ),
    },
  });
});

export const revokeSession = catchAsync(async (req, res) => {
  const revoked = await revokeUserSession({
    userId: req.user.id,
    sessionId: req.params.sessionId,
    reason: "account_session_revoked",
  });
  if (!revoked) {
    return res.status(404).json({
      success: false,
      message: "Session not found",
      errors: [
        { code: "session_not_found", message: "The session is unavailable" },
      ],
    });
  }
  if (cookieSessionId(req) === revoked.sessionId) clearRefreshCookie(res);
  await recordSecurityEvent({
    event: "session_revoked",
    user: req.user.id,
    sessionId: revoked.sessionId,
    req,
  });
  return res
    .status(200)
    .json({ success: true, data: { message: "Session revoked" } });
});

// DELETE /sessions revokes every session for the authenticated account.
export const revokeAllSessions = catchAsync(async (req, res) => {
  const count = await revokeAllUserSessions({
    userId: req.user.id,
    reason: "all_account_sessions_revoked",
  });
  clearRefreshCookie(res);
  await recordSecurityEvent({
    event: "all_sessions_revoked",
    user: req.user.id,
    req,
    metadata: { count },
  });
  return res.status(200).json({
    success: true,
    data: { message: "All sessions revoked", revokedCount: count },
  });
});
