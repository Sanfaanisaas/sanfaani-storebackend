import { env } from "../../config/env.js";

const unavailable = () => Object.assign(new Error("Email provider unavailable"), { retryable: true });

export const emailProvider = {
  async send({ to, subject, text, idempotencyKey }) {
    if (!env.emailProviderEndpoint || !env.emailProviderApiKey || !env.emailFrom) throw unavailable();
    let response;
    try {
      response = await fetch(env.emailProviderEndpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${env.emailProviderApiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ from: env.emailFrom, to, subject, text }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) throw Object.assign(new Error("Email provider rejected delivery"), { retryable: response.status === 429 || response.status >= 500 });
    const body = await response.json().catch(() => ({}));
    return { messageId: String(body.id || body.messageId || idempotencyKey) };
  },
};
