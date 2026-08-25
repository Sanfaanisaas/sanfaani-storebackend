import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("5000"),
  MONGO_URI: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  SECURITY_AUDIT_HMAC_SECRET: z.string().min(32),
  REPAIR_TRACKING_TOKEN_SECRET: z.string().min(32).optional(),
  PAYSTACK_MODE: z.enum(["test", "live"]).default("test"),
  PAYSTACK_SECRET_KEY: z.string().startsWith("sk_"),
  PAYSTACK_CALLBACK_URL: z.string().url(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SENTRY_DSN: z.string().url().optional(),
}).superRefine((data, ctx) => {
  if (data.JWT_SECRET === data.JWT_REFRESH_SECRET) {
    ctx.addIssue({
      code: "custom",
      message: "Access and refresh JWT secrets must be different",
      path: ["JWT_REFRESH_SECRET"],
    });
  }

  if ([data.JWT_SECRET, data.JWT_REFRESH_SECRET].includes(data.SECURITY_AUDIT_HMAC_SECRET)) {
    ctx.addIssue({
      code: "custom",
      message: "The security-audit HMAC secret must be independent of both JWT secrets",
      path: ["SECURITY_AUDIT_HMAC_SECRET"],
    });
  }

  if (data.NODE_ENV === "production" && !data.REPAIR_TRACKING_TOKEN_SECRET) {
    ctx.addIssue({
      code: "custom",
      message: "REPAIR_TRACKING_TOKEN_SECRET is required in production",
      path: ["REPAIR_TRACKING_TOKEN_SECRET"],
    });
  }

  const expectedPrefix =
    data.PAYSTACK_MODE === "live"
      ? "sk_live_"
      : "sk_test_";

  if (!data.PAYSTACK_SECRET_KEY.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: "custom",
      message: "PAYSTACK_SECRET_KEY must match PAYSTACK_MODE",
      path: ["PAYSTACK_SECRET_KEY"],
    });
  }
});

export const validateEnvironment = (values) => envSchema.safeParse(values);

const parsed = validateEnvironment(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment configuration: check required values, URL formats, key modes, and independent 32+ character security secrets.",
  );
  process.exit(1);
}

export const env = {
  port: parsed.data.PORT,
  mongoUri: parsed.data.MONGO_URI,
  jwtSecret: parsed.data.JWT_SECRET,
  jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
  securityAuditHmacSecret: parsed.data.SECURITY_AUDIT_HMAC_SECRET,
  repairTrackingTokenSecret: parsed.data.REPAIR_TRACKING_TOKEN_SECRET,
  paystackMode: parsed.data.PAYSTACK_MODE,
  paystackSecretKey: parsed.data.PAYSTACK_SECRET_KEY,
  paystackCallbackUrl: parsed.data.PAYSTACK_CALLBACK_URL,
  nodeEnv: parsed.data.NODE_ENV,
  sentryDsn: parsed.data.SENTRY_DSN,
};
