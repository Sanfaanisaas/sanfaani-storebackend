const detailFromField = (field, message, code = "validation") => ({
  field,
  code,
  message: String(message),
});

export const normalizeErrorDetails = (details) => {
  if (Array.isArray(details)) return details;
  if (!details || typeof details !== "object") return [];

  return Object.entries(details).flatMap(([field, messages]) => {
    const values = Array.isArray(messages) ? messages : [messages];
    return values.filter(Boolean).map((message) => detailFromField(field, message));
  });
};

// Controllers written before the unified contract sometimes return an error
// body directly. Normalizing at the response boundary guarantees one safe
// envelope for every route while those controllers are migrated incrementally.
export const normalizeErrorEnvelope = (req, res, next) => {
  const sendJson = res.json.bind(res);

  res.json = (body) => {
    if (res.statusCode < 400) return sendJson(body);

    const message = typeof body?.message === "string" && body.message.trim()
      ? body.message
      : "Request failed";

    return sendJson({
      success: false,
      message,
      errors: normalizeErrorDetails(body?.errors),
    });
  };

  next();
};
