import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

process.env.NODE_ENV = "test"; process.env.MONGO_URI = "mongodb://127.0.0.1:27017/readiness"; process.env.JWT_SECRET = "be26-access-secret-32-characters-long"; process.env.JWT_REFRESH_SECRET = "be26-refresh-secret-32-characters-long"; process.env.SECURITY_AUDIT_HMAC_SECRET = "be26-audit-secret-32-characters-long"; process.env.REPAIR_TRACKING_TOKEN_SECRET = "be26-tracking-secret-32-characters-long"; process.env.GUIDANCE_TOKEN_SECRET = "be26-guidance-secret-32-characters-long"; process.env.PUSH_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; process.env.PAYSTACK_SECRET_KEY = "sk_test_be26_contract"; process.env.PAYSTACK_CALLBACK_URL = "https://example.test/callback";
const { readiness } = await import("../services/readinessService.js");
test("BE-26 readiness is dependency-aware and liveness remains separate", () => { const result = readiness(); assert.equal(result.ready, false); assert.deepEqual(Object.keys(result.dependencies).sort(), ["configuration", "mongo"].sort()); assert.equal(JSON.stringify(result).includes("secret"), false); assert.equal(mongoose.connection.readyState, 0); });
