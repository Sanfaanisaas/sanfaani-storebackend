import { env } from "../../config/env.js";

const unavailable = () => Object.assign(new Error("Push provider unavailable"), { retryable: true });

export const pushProvider = {
  async send({ tokens, title, body, deepLink, idempotencyKey }) {
    if (!env.pushProviderEndpoint || !env.pushProviderApiKey) throw unavailable();
    let response;
    try {
      response = await fetch(env.pushProviderEndpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${env.pushProviderApiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ tokens, title, body, data: { deepLink } }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) throw Object.assign(new Error("Push provider rejected delivery"), { retryable: response.status === 429 || response.status >= 500 });
    const result = await response.json().catch(() => ({}));
    return { messageId: String(result.id || result.messageId || idempotencyKey), invalidTokens: Array.isArray(result.invalidTokens) ? result.invalidTokens.filter((token) => typeof token === "string") : [] };
  },
};
