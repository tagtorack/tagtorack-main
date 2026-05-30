// functions/_shared/r2-sign.js
// AWS SigV4 presigned URL generator for Cloudflare R2's S3-compatible API.
// Web Crypto only (no aws-sdk; SDK is too heavy for Pages Functions).
//
// Reference: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
//
// Required env on the Pages project (set in Pages dashboard → Functions vars):
//   R2_ACCOUNT_ID            Cloudflare account ID (the R2 host prefix)
//   R2_ACCESS_KEY_ID         from `wrangler r2 bucket api-token create`
//   R2_SECRET_ACCESS_KEY     same
//   R2_BUCKET                "tagtorack-submissions"

const enc = new TextEncoder();

const sha256Hex = async (msg) => {
  const buf = typeof msg === "string" ? enc.encode(msg) : msg;
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmac = async (key, msg) => {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
};

// "20260530T143000Z"
const fmtDate = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
// "20260530"
const fmtDay = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

// RFC3986-strict percent-encoding (additionally encodes !'()*).
const enc3986 = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

/**
 * Generate a presigned R2 URL.
 *
 * @param {object} opts
 * @param {string} opts.accessKeyId
 * @param {string} opts.secretAccessKey
 * @param {string} opts.accountId        Cloudflare account ID
 * @param {string} opts.bucket
 * @param {string} opts.key              No leading slash
 * @param {"GET"|"PUT"} opts.method
 * @param {number} opts.expiresSec       Max 604800 (7d)
 * @param {Record<string,string>} [opts.signedHeaders]  Headers the caller MUST send with the request
 * @returns {Promise<string>} Fully-qualified https URL
 */
export async function presignR2Url(opts) {
  const {
    accessKeyId,
    secretAccessKey,
    accountId,
    bucket,
    key,
    method,
    expiresSec,
    signedHeaders = {},
  } = opts;

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = fmtDate(now);
  const dayDate = fmtDay(now);
  const credScope = `${dayDate}/${region}/${service}/aws4_request`;
  const cred = `${accessKeyId}/${credScope}`;

  // Canonical signed-headers list. host always required.
  const headers = {
    host,
    ...Object.fromEntries(
      Object.entries(signedHeaders).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaderStr = headerNames.join(";");

  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": cred,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": signedHeaderStr,
  };
  const sortedQs = Object.keys(query)
    .sort()
    .map((k) => `${enc3986(k)}=${enc3986(query[k])}`)
    .join("&");

  const canonicalUri = "/" + enc3986(bucket) + "/" + key.split("/").map(enc3986).join("/");
  const canonicalReq = [
    method,
    canonicalUri,
    sortedQs,
    canonicalHeaders,
    signedHeaderStr,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credScope,
    await sha256Hex(canonicalReq),
  ].join("\n");

  const kDate = await hmac("AWS4" + secretAccessKey, dayDate);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const sig = [...(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `https://${host}${canonicalUri}?${sortedQs}&X-Amz-Signature=${sig}`;
}

// Convenience: generate {role, ord, r2_key, put_url} for each declared photo.
// Caller is responsible for storing r2_key in Postgres.
export async function presignUploadUrls(env, merchantSlug, submissionId, photoDeclarations) {
  const out = [];
  for (const p of photoDeclarations) {
    const ts = Date.now();
    // {slug}/{sub}/{role}-{ord}-{ts}.jpg
    const ext = (p.content_type || "image/jpeg").includes("png") ? "png" : "jpg";
    const r2_key = `${merchantSlug}/${submissionId}/${p.role}-${p.ord || 1}-${ts}.${ext}`;
    const put_url = await presignR2Url({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      key: r2_key,
      method: "PUT",
      expiresSec: 300, // 5 minutes
      signedHeaders: { "content-type": p.content_type || "image/jpeg" },
    });
    out.push({
      role: p.role,
      ord: p.ord || 1,
      r2_key,
      put_url,
      max_bytes: 8 * 1024 * 1024,
    });
  }
  return out;
}

// Convenience: presigned GET URLs for embedding in merchant notification emails.
export async function presignReadUrl(env, r2_key, expiresSec = 86400) {
  return presignR2Url({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    key: r2_key,
    method: "GET",
    expiresSec,
  });
}
