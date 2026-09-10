/**
 * Browsable API docs, generated from openapi.yaml — the hand-maintained
 * source of truth for the public surface:
 *
 *   GET /api/openapi.yaml   the spec itself
 *   GET /api/docs           Swagger UI rendering it (with "Try it out")
 *
 * Swagger UI's assets are served from the swagger-ui-dist package, not a CDN,
 * so the docs work on an offline local stack like everything else. No key is
 * needed to read the docs; trying a request needs one, entered via Authorize.
 *
 * The spec is kept honest by tests, not by this file: the integration test
 * validates every live /api/v1 response against it, and the SDK's types are
 * generated from it.
 */
import express, { Router } from "express";
import { readFileSync } from "fs";
import { dirname, join } from "path";

// openapi.yaml is at the repo root; from apps/api/{src,dist}/ that is three
// levels up. OPENAPI_PATH overrides it if the layout differs.
const OPENAPI_PATH =
  process.env.OPENAPI_PATH ?? join(__dirname, "..", "..", "..", "openapi.yaml");

const SWAGGER_UI_DIR = dirname(require.resolve("swagger-ui-dist/package.json"));

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Virtual Judge Execution API</title>
  <link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/assets/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "/api/openapi.yaml", dom_id: "#swagger-ui" });
  </script>
</body>
</html>`;

export function docsRouter(): Router {
  const router = Router();

  let spec: string | null = null;
  try {
    spec = readFileSync(OPENAPI_PATH, "utf8");
  } catch (err) {
    // The docs are not worth refusing to start the API over.
    console.error(`[docs] could not read ${OPENAPI_PATH}; /api/docs will be unavailable:`, err);
  }

  router.get("/api/openapi.yaml", (_req, res) => {
    if (spec === null) {
      res.sendStatus(404);
      return;
    }
    res.type("application/yaml").send(spec);
  });
  router.get("/api/docs", (_req, res) => {
    res.type("html").send(PAGE);
  });
  router.use("/api/docs/assets", express.static(SWAGGER_UI_DIR, { index: false }));

  return router;
}
