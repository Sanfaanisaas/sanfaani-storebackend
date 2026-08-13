const DEFAULT_TRUSTED_ORIGIN = "http://localhost:3000";

const parseHttpUrl = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value === "null") {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP(S) URL`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.origin === "null") {
    throw new TypeError(`${label} must be a credential-free HTTP(S) URL`);
  }
  return parsed;
};

export const parseTrustedOrigins = (
  configured = process.env.CORS_ORIGIN || DEFAULT_TRUSTED_ORIGIN,
) => {
  if (typeof configured !== "string") {
    throw new TypeError("CORS_ORIGIN must be a comma-separated string");
  }

  const entries = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (!entries.length || entries.includes("*")) {
    throw new TypeError("CORS_ORIGIN must contain explicit HTTP(S) origins");
  }

  return new Set(entries.map((entry) => {
    const parsed = parseHttpUrl(entry, "Configured origin");
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new TypeError("Configured origins cannot contain paths, queries, or fragments");
    }
    return parsed.origin;
  }));
};

export const parseOriginHeader = (value) => {
  const parsed = parseHttpUrl(value, "Origin");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Origin must contain only a serialized origin");
  }
  return parsed.origin;
};

export const parseRefererOrigin = (value) => parseHttpUrl(value, "Referer").origin;

export const isTrustedOrigin = (value, trustedOrigins = parseTrustedOrigins()) => (
  trustedOrigins.has(parseOriginHeader(value))
);
