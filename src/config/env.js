import dotenv from "dotenv";
dotenv.config();

const requiredEnvVars = [
  "MONGO_URI",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_CALLBACK_URL",
];

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const env = {
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  paystackCallbackUrl: process.env.PAYSTACK_CALLBACK_URL,
};