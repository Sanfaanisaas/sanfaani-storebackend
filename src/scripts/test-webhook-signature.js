import crypto from "crypto";
import axios from "axios";

const PAYSTACK_SECRET_KEY = "sk_test_mock_key_for_development";
const WEBHOOK_URL = "http://localhost:5000/api/payments/webhook";

const payload = JSON.stringify({
  event: "charge.success",
  data: {
    reference: "test-ref-123",
    status: "success",
    amount: 500000,
  },
});

const correctSignature = crypto
  .createHmac("sha512", PAYSTACK_SECRET_KEY)
  .update(payload)
  .digest("hex");

const wrongSignature = "wrong-signature";

async function testWebhook() {
  console.log("--- Testing Webhook Signature Verification ---");

  // Test 1: Wrong Signature
  try {
    console.log("Test 1: Sending request with WRONG signature...");
    const res = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": wrongSignature,
      },
    });
    console.log("Result: FAILED (Should have been rejected with 400, but got 200)");
  } catch (error) {
    if (error.response?.status === 400) {
      console.log("Result: PASSED (Rejected with 400 as expected)");
    } else {
      console.log(`Result: FAILED (Expected 400, got ${error.response?.status || error.message})`);
    }
  }

  // Test 2: Correct Signature
  try {
    console.log("\nTest 2: Sending request with CORRECT signature...");
    const res = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-paystack-signature": correctSignature,
      },
    });
    if (res.status === 200) {
      console.log("Result: PASSED (Accepted with 200)");
    } else {
      console.log(`Result: FAILED (Expected 200, got ${res.status})`);
    }
  } catch (error) {
    console.log(`Result: FAILED (Error: ${error.response?.data?.message || error.message})`);
  }
}

testWebhook();
