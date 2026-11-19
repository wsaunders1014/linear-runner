import crypto from 'node:crypto';

const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Computes Linear's HMAC-SHA256 hex digest over the raw request body bytes.
 */
export function computeLinearSignature(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verifies the Linear-Signature header in constant time over the raw body Buffer.
 * Linear sends a bare 64-char hex HMAC-SHA256 digest (no "sha256=" prefix).
 */
export function verifyLinearSignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof signatureHeader !== 'string') return false;
  const trimmed = signatureHeader.trim();
  if (!HEX_64_RE.test(trimmed)) return false;

  const expectedHex = computeLinearSignature(rawBody, secret);
  const providedBuf = Buffer.from(trimmed.toLowerCase(), 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Rejects webhookTimestamp values that are missing, non-numeric, in the future,
 * or older than maxAgeMs (default 60 seconds).
 */
export function verifyWebhookTimestamp(webhookTimestamp, { now = Date.now(), maxAgeMs = 60_000 } = {}) {
  if (typeof webhookTimestamp !== 'number' || !Number.isFinite(webhookTimestamp)) {
    return { ok: false, reason: 'missing_or_invalid_timestamp' };
  }
  if (webhookTimestamp > now) {
    return { ok: false, reason: 'timestamp_in_future' };
  }
  if (now - webhookTimestamp > maxAgeMs) {
    return { ok: false, reason: 'timestamp_too_old' };
  }
  return { ok: true };
}
