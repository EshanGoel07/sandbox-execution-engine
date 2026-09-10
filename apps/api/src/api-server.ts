/**
 * One process, two route trees, two auth strategies:
 *
 *   /app/*     the judge web client     session auth (JWT)   routes/app
 *   /api/v1/*  the public execution API API-key auth         routes/v1
 *
 * plus /health and the /ws WebSocket hub (session-auth'd per subscribe frame).
 *
 * One process rather than two services: a second deployment would double the
 * ops surface for no benefit at this scale. The separation that matters is
 * the route tree and the auth boundary, and that's enforced here — each tree
 * is its own router with its own auth middleware, body parser and error
 * shape, and no handler is mounted in both.
 */
import express from "express";
import http from "http";
import { runMigrations } from "@vj/infra";
import { attachWebSocketGateway } from "./ws-hub";
import { DEMO_MODE } from "./config";
import { appRouter } from "./routes/app";
import { v1Router } from "./routes/v1";

export { DEMO_MODE };

export function buildApp(): express.Express {
  const app = express();

  // Behind a reverse proxy (a hosting provider's load balancer), the client
  // IP the rate limiter keys on is in X-Forwarded-For, not the socket. Only
  // trust that header when TRUST_PROXY says how many proxies are in front —
  // trusting it blindly would let a client spoof its IP and dodge the limit.
  // Unset (the default, and correct for the direct-connection docker-compose
  // stack) => Express does not trust the header at all.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true");
  }

  // Cross-origin calls are allowed on both trees. The web client is served
  // from a different origin than the API, and public-API callers can be
  // anywhere. That's safe because both trees authenticate with a bearer
  // header, never a cookie: a malicious page has no ambient credential to
  // ride on, so there's nothing for a CORS restriction to protect.
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.header("Access-Control-Expose-Headers", "Location");
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, demoMode: DEMO_MODE });
  });

  app.use("/app", appRouter());
  app.use("/api/v1", v1Router());

  return app;
}

export async function startApiServer(port: number): Promise<http.Server> {
  await runMigrations();
  const app = buildApp();
  const server = http.createServer(app);
  attachWebSocketGateway(server);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  startApiServer(port).then(() => {
    console.log(`api-gateway listening on :${port} (DEMO_MODE=${DEMO_MODE})`);
  });
}
