/**
 * GET /api/v1/languages — straight from @vj/shared's LANGUAGE_INFO, the same
 * table the rest of the system is typed against. Image names and build
 * commands are engine internals and deliberately not part of this contract.
 */
import { Router } from "express";
import { LANGUAGES, LANGUAGE_INFO } from "@vj/shared";

export function languagesRouter(): Router {
  const router = Router();
  const body = { data: LANGUAGES.map((id) => LANGUAGE_INFO[id]) };

  router.get("/languages", (_req, res) => {
    res.json(body);
  });

  return router;
}
