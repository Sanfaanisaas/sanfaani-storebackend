import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("5000"),
  MONGO_URI: z.string().url(),
  JWT_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),
  PAYSTACK_MODE: z.enum(["test", "live"]).default("test"),
  PAYSTACK_SECRET_KEY: z.string().startsWith("sk_"),
  PAYSTACK_CALLBACK_URL: z.string().url(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SENTRY_DSN: z.string().url().optional(),
}).refine((data) => {
  const expectedPrefix =
    data.PAYSTACK_MODE === "live"
      ? "sk_live_"
      : "sk_test_";

  return data.PAYSTACK_SECRET_KEY.startsWith(expectedPrefix);
}, {
  message: "PAYSTACK_SECRET_KEY must match PAYSTACK_MODE",
  path: ["PAYSTACK_SECRET_KEY"],
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.format());
  process.exit(1);
}

export const env = {
  port: parsed.data.PORT,
  mongoUri: parsed.data.MONGO_URI,
  jwtSecret: parsed.data.JWT_SECRET,
  jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
  paystackMode: parsed.data.PAYSTACK_MODE,
  paystackSecretKey: parsed.data.PAYSTACK_SECRET_KEY,
  paystackCallbackUrl: parsed.data.PAYSTACK_CALLBACK_URL,
  nodeEnv: parsed.data.NODE_ENV,
  sentryDsn: parsed.data.SENTRY_DSN,
};
