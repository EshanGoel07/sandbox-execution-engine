/**
 * API key management, under the SESSION tree:
 *
 *   POST   /app/api-keys      create — the full key is in this response and nowhere else, ever
 *   GET    /app/api-keys      list   — prefix + metadata, never the key or its hash
 *   DELETE /app/api-keys/:id  revoke — soft, idempotent
 *
 * These use session auth, not key auth, on purpose: if a key could mint keys,
 * one leaked key would let an attacker create replacements that survive its
 * revocation. Keys are managed by the account holder, and only used by
 * programs.
 */
import { Router } from "express";
import { createApiKey, listApiKeys, revokeApiKey } from "@vj/infra";
import type { ApiKeySummary } from "@vj/infra";
import { requireAuth, AuthedRequest } from "../../auth/session";
import { generateApiKey } from "../../auth/api-key";
import { MAX_ACTIVE_API_KEYS } from "../../config";

const MAX_NAME_LENGTH = 100;

function toWire(k: ApiKeySummary) {
  return {
    id: k.id,
    name: k.name,
    key_prefix: k.keyPrefix,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt,
    revoked_at: k.revokedAt,
  };
}

export function apiKeysRouter(): Router {
  const router = Router();

  router.post("/api-keys", requireAuth, async (req: AuthedRequest, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_LENGTH) {
      res.status(400).json({
        error: `name is required (a label for this key, at most ${MAX_NAME_LENGTH} characters)`,
      });
      return;
    }

    const { key, keyPrefix, keyHash } = generateApiKey();
    const created = await createApiKey({
      userId: req.userId!,
      name: name.trim(),
      keyPrefix,
      keyHash,
      maxActive: MAX_ACTIVE_API_KEYS,
    });
    if (!created) {
      res.status(409).json({
        error: `you already have ${MAX_ACTIVE_API_KEYS} active API keys — revoke one first`,
      });
      return;
    }

    // The only time the full key is ever sent. Only its hash was stored.
    res.status(201).json({ ...toWire(created), key });
  });

  router.get("/api-keys", requireAuth, async (req: AuthedRequest, res) => {
    const keys = await listApiKeys(req.userId!);
    res.json(keys.map(toWire));
  });

  // Someone else's key id is a 404, the same as a missing one.
  router.delete("/api-keys/:id", requireAuth, async (req: AuthedRequest, res) => {
    const keyId = Number(req.params.id);
    // Outside Postgres's INTEGER range the query would error (a 500); it can't
    // match a key anyway.
    const valid = Number.isInteger(keyId) && keyId > 0 && keyId <= 2_147_483_647;
    const revoked = valid && (await revokeApiKey(keyId, req.userId!));
    if (!revoked) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.sendStatus(204);
  });

  return router;
}
