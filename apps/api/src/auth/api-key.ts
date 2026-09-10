/**
 * API-key auth for the public /api/v1 tree.
 *
 * Format: `vj_live_` + 43 random base62 chars (43 * log2(62) ≈ 256 bits).
 * The key is shown to its owner exactly once, at creation; only its SHA-256
 * is stored.
 *
 * Why SHA-256 and not bcrypt — the opposite of the password rule, on purpose:
 *
 *   bcrypt is deliberately slow (~250ms at cost 12) because a password is a
 *   LOW-entropy human secret: if the hash table leaks, an attacker can guess
 *   likely passwords offline, and the only defence is making each guess
 *   expensive. An API key is 256 bits from a CSPRNG. There is nothing to
 *   guess — brute-forcing 2^256 is impossible at any hash speed — so bcrypt's
 *   slowness buys no security here. What it WOULD do is add ~250ms of CPU to
 *   every single authenticated request, on an API whose selling point is
 *   single-digit-millisecond latency.
 *
 *   It also dictates the lookup. bcrypt hashes are salted, so the same key
 *   hashes differently every time and can't be indexed — you'd have to find
 *   candidate rows by a plaintext prefix and bcrypt-compare each. An unsalted
 *   SHA-256 is deterministic, so auth is one equality lookup on a UNIQUE
 *   index. No salt is needed either: salts defeat precomputed (rainbow)
 *   tables, and nobody can precompute a table over 2^256 inputs.
 *
 *   And it leaks nothing through timing: the index comparison can at most
 *   reveal bytes of the *hash* an attacker supplied, and turning a hash back
 *   into a key would need a SHA-256 preimage.
 */
import { createHash, randomBytes } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { findApiKeyByHash, touchApiKeyLastUsed } from "@vj/infra";
import { sendError } from "../routes/v1/errors";

const KEY_PREFIX = "vj_live_";
const KEY_RANDOM_CHARS = 43;
// How many random chars are kept (with KEY_PREFIX) as the displayable prefix.
// Enough to tell a user's keys apart; far too few to help guess one.
const DISPLAY_RANDOM_CHARS = 8;

const KEY_RE = new RegExp(`^${KEY_PREFIX}[0-9A-Za-z]{${KEY_RANDOM_CHARS}}$`);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * `length` uniformly random base62 chars. Rejection sampling: bytes 248..255
 * are discarded, because 256 isn't a multiple of 62 and `byte % 62` over the
 * full range would make the first 8 characters slightly more likely.
 */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue; // 248 = 62 * 4
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const random = randomBase62(KEY_RANDOM_CHARS);
  const key = KEY_PREFIX + random;
  return {
    key,
    keyPrefix: KEY_PREFIX + random.slice(0, DISPLAY_RANDOM_CHARS),
    keyHash: hashApiKey(key),
  };
}

export interface ApiKeyRequest extends Request {
  apiKey?: { id: number; userId: number };
}

/**
 * 401s unless `Authorization: Bearer <live, unrevoked key>` is present, and
 * otherwise sets req.apiKey. The key is read from the header only — never a
 * query parameter, where it would end up in access logs and browser history.
 *
 * A session JWT sent here fails the format check, and an API key sent to the
 * /app tree fails JWT verification: neither credential opens the other tree.
 */
export async function requireApiKey(
  req: ApiKeyRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  // Cheap shape check first: garbage and JWTs are rejected without a DB hit.
  if (!KEY_RE.test(presented)) {
    sendError(res, 401, "unauthorized", "Missing or malformed API key. Send `Authorization: Bearer vj_live_...`.");
    return;
  }

  const key = await findApiKeyByHash(hashApiKey(presented));
  if (!key) {
    sendError(res, 401, "unauthorized", "Invalid API key.");
    return;
  }
  // A distinct code is safe here: only someone holding the full key can learn
  // it was revoked, so it enumerates nothing — and it tells a legitimate
  // client to stop retrying and rotate.
  if (key.revoked) {
    sendError(res, 401, "key_revoked", "This API key has been revoked.");
    return;
  }

  req.apiKey = { id: key.id, userId: key.userId };
  // Off the critical path: the response doesn't wait for this write.
  touchApiKeyLastUsed(key.id).catch((err) =>
    console.error("[api/v1] failed to record key usage:", err)
  );
  next();
}
