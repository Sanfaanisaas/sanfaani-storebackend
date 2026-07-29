import { rateLimit } from "express-rate-limit";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per `window`
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    status: "fail",
    message: "Too many login/registration attempts, please try again after 15 minutes",
  },
  validate: { xForwardedForHeader: false, defaultKeys: false },
  keyGenerator: (req) => {
    // Key on email + IP combined for login, otherwise just IP
    if (req.path === "/login" && req.body && req.body.email) {
      return `${req.ip}-${req.body.email}`;
    }
    return req.ip;
  },
  skipSuccessfulRequests: false,
});

export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "fail",
    message: "Too many payment attempts, please try again after 15 minutes",
  },
  validate: { xForwardedForHeader: false, defaultKeys: false },
  keyGenerator: (req) => {
    // Key on authenticated user ID
    return req.user ? req.user.id : req.ip;
  },
});
