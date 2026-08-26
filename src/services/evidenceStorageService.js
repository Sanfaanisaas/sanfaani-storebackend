import crypto from "node:crypto";
import AppError from "../utils/AppError.js";
import { env } from "../config/env.js";

export const MAX_EVIDENCE_FILES = 1;
export const MAX_EVIDENCE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_EVIDENCE_REQUEST_BYTES = MAX_EVIDENCE_FILE_BYTES;
export const EVIDENCE_MIME_TYPES = Object.freeze(["image/jpeg", "image/png", "application/pdf"]);

const detectedMime = (buffer) => {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
};

const invalidFile = (message) => new AppError(message, 400, [{ code: "evidence_file_invalid", message }]);
const safeDisplayName = (name) => {
  const base = String(name || "evidence").split(/[\\/]/).pop();
  const value = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim().slice(0, 160);
  return value || "evidence";
};

// The signature is authoritative. The submitted MIME type is checked only as
// a consistency signal so a JPEG declared as a PDF cannot bypass a client bug.
export const validateEvidenceFile = (file) => {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) throw invalidFile("Evidence files must not be empty");
  if (file.buffer.length > MAX_EVIDENCE_FILE_BYTES) throw invalidFile("Evidence file exceeds the 5 MiB limit");
  const type = detectedMime(file.buffer);
  if (!type || !EVIDENCE_MIME_TYPES.includes(type) || String(file.mimetype || "").toLowerCase() !== type) {
    throw invalidFile("Unsupported or mismatched evidence file content");
  }
  return {
    detectedMimeType: type,
    checksum: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    size: file.buffer.length,
    displayName: safeDisplayName(file.originalname),
  };
};

// Do not include subjects, original names, owners, serials, or customer data.
export const generatedObjectKey = () => `private/evidence/${crypto.randomBytes(32).toString("base64url")}`;

const unavailable = () => new AppError("Evidence storage is temporarily unavailable", 503, [{ code: "evidence_storage_unavailable", message: "Please try again later" }]);
const assertStorageInterface = (candidate) => {
  for (const name of ["putObject", "getSignedDownloadUrl", "deleteObject", "headObject"]) {
    if (typeof candidate?.[name] !== "function") throw new TypeError(`Evidence storage adapter must implement ${name}`);
  }
  return candidate;
};

let injectedAdapter = null;
let productionAdapter = null;

export const setEvidenceStorageAdapter = (nextAdapter) => {
  injectedAdapter = nextAdapter == null ? null : assertStorageInterface(nextAdapter);
};

// This adapter is test-only and intentionally uses opaque URLs; neither the
// object key nor a bucket name appears in a customer result.
export const memoryEvidenceStorageAdapter = () => {
  const objects = new Map();
  const downloads = new Map();
  return {
    async putObject({ key, body, contentType, checksum }) {
      objects.set(key, { body: Buffer.from(body), contentType, checksum });
      return { key };
    },
    async getSignedDownloadUrl({ key, expiresInSeconds }) {
      if (!objects.has(key)) throw new AppError("Evidence is unavailable", 404);
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
      downloads.set(token, { key, expiresAt });
      return { url: `memory://evidence-download/${token}`, expiresAt };
    },
    async deleteObject({ key }) {
      const deleted = objects.delete(key);
      return { deleted };
    },
    async headObject({ key }) {
      const object = objects.get(key);
      return object ? { exists: true, size: object.body.length, contentType: object.contentType } : { exists: false };
    },
    // Narrow test inspection only; production code never uses these helpers.
    keys: () => [...objects.keys()],
    objectCount: () => objects.size,
  };
};

const awsEncode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value, encoding) => crypto.createHmac("sha256", key).update(value).digest(encoding);
const amzDate = (date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const canonicalQuery = (entries) => [...entries]
  .map(([key, value]) => [awsEncode(key), awsEncode(value)])
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, value]) => `${key}=${value}`)
  .join("&");

const signingKey = (secret, dateStamp, region) => {
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
};

const normalizeEndpoint = (endpoint) => {
  const url = new URL(endpoint);
  if (!/^https?:$/.test(url.protocol)) throw new TypeError("Object storage endpoint must use HTTP(S)");
  return url;
};

const createObjectUrl = (config, key) => {
  const endpoint = normalizeEndpoint(config.endpoint);
  const encodedKey = key.split("/").map(awsEncode).join("/");
  const basePath = endpoint.pathname.replace(/\/$/, "");
  if (config.forcePathStyle) endpoint.pathname = `${basePath}/${awsEncode(config.bucket)}/${encodedKey}`;
  else {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${basePath}/${encodedKey}`;
  }
  return endpoint;
};

const storageConfig = () => ({
  endpoint: env.objectStorageEndpoint,
  region: env.objectStorageRegion,
  bucket: env.objectStorageBucket,
  accessKeyId: env.objectStorageAccessKeyId,
  secretAccessKey: env.objectStorageSecretAccessKey,
  forcePathStyle: env.objectStorageForcePathStyle,
  signedUrlTtlSeconds: env.objectStorageSignedUrlTtlSeconds,
});

const signedHeaders = ({ host, ...headers }) => ({ host, ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()])) });
const makeAuthorization = (config, method, url, headers, payloadHash, now) => {
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const canonicalHeaders = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right));
  const headerString = canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
  const names = canonicalHeaders.map(([name]) => name).join(";");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const request = [method, url.pathname, url.search.slice(1), headerString, names, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(request)].join("\n");
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp, config.region), stringToSign, "hex");
  return `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`;
};

// Minimal SigV4 S3-compatible client. It keeps SDK/provider objects outside
// route code and avoids adding a local-disk production fallback.
export const createS3CompatibleStorageAdapter = (configuration = storageConfig()) => {
  const config = { ...configuration };
  for (const value of [config.endpoint, config.region, config.bucket, config.accessKeyId, config.secretAccessKey]) {
    if (!value) throw new TypeError("Complete object-storage configuration is required");
  }
  const request = async (method, key, { body, contentType } = {}) => {
    const url = createObjectUrl(config, key);
    const now = new Date();
    const payloadHash = sha256(body || "");
    const headers = signedHeaders({
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate(now),
      ...(contentType ? { "content-type": contentType } : {}),
    });
    const authorization = makeAuthorization(config, method, url, headers, payloadHash, now);
    try {
      const response = await fetch(url, {
        method,
        headers: { ...headers, authorization },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) return { missing: true };
      if (!response.ok) throw new Error(`object-storage-${response.status}`);
      return { response };
    } catch {
      throw unavailable();
    }
  };
  return assertStorageInterface({
    async putObject({ key, body, contentType }) {
      const result = await request("PUT", key, { body, contentType });
      if (result.missing) throw unavailable();
      return { key };
    },
    async deleteObject({ key }) {
      const result = await request("DELETE", key);
      return { deleted: !result.missing };
    },
    async headObject({ key }) {
      const result = await request("HEAD", key);
      if (result.missing) return { exists: false };
      return { exists: true, size: Number(result.response.headers.get("content-length")) || undefined, contentType: result.response.headers.get("content-type") || undefined };
    },
    async getSignedDownloadUrl({ key, expiresInSeconds }) {
      const expires = Math.max(60, Math.min(Number(expiresInSeconds) || config.signedUrlTtlSeconds, config.signedUrlTtlSeconds));
      const url = createObjectUrl(config, key);
      const now = new Date();
      const date = amzDate(now);
      const dateStamp = date.slice(0, 8);
      const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
      const query = canonicalQuery([
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
        ["X-Amz-Date", date],
        ["X-Amz-Expires", String(expires)],
        ["X-Amz-SignedHeaders", "host"],
      ]);
      const canonical = ["GET", url.pathname, query, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
      const signature = hmac(signingKey(config.secretAccessKey, dateStamp, config.region), ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n"), "hex");
      url.search = `${query}&X-Amz-Signature=${signature}`;
      return { url: url.toString(), expiresAt: new Date(now.getTime() + expires * 1000) };
    },
  });
};

export const getEvidenceStorageAdapter = () => {
  if (injectedAdapter) return injectedAdapter;
  if (env.nodeEnv === "production") {
    productionAdapter ||= createS3CompatibleStorageAdapter();
    return productionAdapter;
  }
  throw unavailable();
};

export const putEvidenceObject = ({ key, body, contentType, checksum }) => getEvidenceStorageAdapter().putObject({ key, body, contentType, checksum });
export const deleteEvidenceObject = (key) => getEvidenceStorageAdapter().deleteObject({ key });
export const headEvidenceObject = (key) => getEvidenceStorageAdapter().headObject({ key });
export const issueEvidenceDownload = (key, ttlSeconds = env.objectStorageSignedUrlTtlSeconds) => getEvidenceStorageAdapter().getSignedDownloadUrl({ key, expiresInSeconds: ttlSeconds });
