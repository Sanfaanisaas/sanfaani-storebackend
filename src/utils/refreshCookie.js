import { env } from "../config/env.js";
import { REFRESH_TOKEN_MAX_AGE_MS } from "../services/tokenService.js";

export const REFRESH_COOKIE_NAME = "refreshToken";

export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.nodeEnv === "production",
  sameSite: env.nodeEnv === "production" ? "none" : "lax",
  path: "/api/auth",
  maxAge: REFRESH_TOKEN_MAX_AGE_MS,
});

export const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
};

export const clearRefreshCookie = (res) => {
  const { maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, options);
};
