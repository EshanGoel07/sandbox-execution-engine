import express, { NextFunction, Request, Response } from "express";
import http from "http";
import rateLimit from "express-rate-limit";
import { isLanguage } from "@vj/shared";
import {
  runMigrations,
  createProblem,
  listProblems,
  getProblemPublic,
  createSubmission,
  getSubmissionForOwner,
  markSubmissionDemoDisabled,
  createUser,
  getUserByEmail,
  getUserById,
  getUserProfile,
  getUserSubmissionsForProblem,
  enqueueSubmission,
} from "@vj/infra";
import { attachWebSocketGateway } from "./ws-hub";
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  AuthedRequest,
} from "./auth";

// When DEMO_MODE=true the API still accepts and persists submissions, but
// never puts them on the queue — so no worker and no Docker sandbox is
// required. Arbitrary code execution isn't something you can safely expose
// on shared free hosting without a dedicated, locked-down Docker host, so the
// public demo deliberately stops here and points people at the one-command
// local docker-compose stack instead. Auth, profiles and submission history
// all work exactly the same in demo mode — only the sandbox step is skipped.
export const DEMO_MODE = process.env.DEMO_MODE === "true";

const DEMO_MESSAGE =
  "Sandbox execution is disabled in this public demo — arbitrary code " +
  "execution isn't safe to expose on free shared hosting without a " +
  "dedicated Docker host. Your submission was still stored. Run the full " +
  "stack locally with `docker compose up` (see the README) for real " +
  "judging, or watch the demo video.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- tunables (all env-overridable) --------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Cap on the JSON request body. A submission's source code is the only large
// field and is separately capped below; everything else is tiny.
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? "256kb";

// Hard cap on a single submission's source code. 64 KiB is far more than any
// real solution and keeps a hostile client from filling Postgres or the
// grader's file copy with megabytes of text.
const MAX_SOURCE_CODE_BYTES = envInt("MAX_SOURCE_CODE_BYTES", 64 * 1024);

// Rate limits. Defaults are deliberately strict for the public-facing case;
// the load test relaxes them via these same env vars (see loadtest/README.md).
const SIGNUP_RATE_WINDOW_MS = envInt("SIGNUP_RATE_WINDOW_MS", 60 * 60 * 1000); // 1h
const SIGNUP_RATE_MAX = envInt("SIGNUP_RATE_MAX", 3);
const LOGIN_RATE_WINDOW_MS = envInt("LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000); // 15m
const LOGIN_RATE_MAX = envInt("LOGIN_RATE_MAX", 5);
const SUBMISSION_RATE_WINDOW_MS = envInt("SUBMISSION_RATE_WINDOW_MS", 60 * 1000); // 1m
const SUBMISSION_RATE_MAX = envInt("SUBMISSION_RATE_MAX", 20);

function makeLimiter(opts: {
  windowMs: number;
  max: number;
  message: string;
  keyGenerator?: (req: Request) => string;
}) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator,
    // We set Express's own `trust proxy` deliberately from TRUST_PROXY above;
    // don't let the limiter second-guess that choice at first request.
    validate: { trustProxy: false },
    handler: (_req, res) => {
      res.status(429).json({ error: opts.message });
    },
  });
}

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

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // The frontend is served from a different origin (its own static host in
  // the demo, a different port in local dev), so allow cross-origin reads
  // and the Authorization header.
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, demoMode: DEMO_MODE });
  });

  // --- auth ---------------------------------------------------------------

  const signupLimiter = makeLimiter({
    windowMs: SIGNUP_RATE_WINDOW_MS,
    max: SIGNUP_RATE_MAX,
    message: "too many signups from this address, please try again later",
  });
  const loginLimiter = makeLimiter({
    windowMs: LOGIN_RATE_WINDOW_MS,
    max: LOGIN_RATE_MAX,
    message: "too many login attempts, please try again later",
  });

  app.post("/auth/signup", signupLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "password must be at least 8 characters" });
      return;
    }
    // The UNIQUE constraint on users.email is the real guard. The pre-check is
    // only for a friendlier message; catching 23505 below closes the race
    // where two concurrent signups both pass the pre-check.
    //
    // Deliberate: a distinct 409 for "already registered" leaks that an email
    // has an account. Signup enumeration is near-unavoidable (an attacker can
    // always just try to register) and hiding it — a fake 201, then a
    // password-reset dance — wrecks the UX for the common honest case. So we
    // accept it here, and only defend enumeration on /auth/login (generic
    // error + constant-time compare).
    if (await getUserByEmail(email)) {
      res.status(409).json({ error: "an account with that email already exists" });
      return;
    }
    let user;
    try {
      user = await createUser(email, await hashPassword(password));
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "an account with that email already exists" });
        return;
      }
      throw err;
    }
    res.status(201).json({
      token: signToken(user.id),
      user: { id: user.id, email: user.email },
    });
  });

  app.post("/auth/login", loginLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    const user = await getUserByEmail(email);
    // Always run a bcrypt compare, even when the email is unknown (passing
    // null makes verifyPassword compare against a dummy hash) — so a missing
    // account and a wrong password take the same time and can't be told apart.
    const ok = await verifyPassword(password, user ? user.password_hash : null);
    if (!user || !ok) {
      res.status(401).json({ error: "invalid email or password" });
      return;
    }
    res.json({
      token: signToken(user.id),
      user: { id: user.id, email: user.email },
    });
  });

  app.get("/auth/me", requireAuth, async (req: AuthedRequest, res) => {
    const user = await getUserById(req.userId!);
    if (!user) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ id: user.id, email: user.email });
  });

  app.get("/profile", requireAuth, async (req: AuthedRequest, res) => {
    const profile = await getUserProfile(req.userId!);
    if (!profile) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(profile);
  });

  // --- problems ----------------------------------------------------------

  // Creating problems is an authoring action, not a public one. Plain
  // requireAuth (any logged-in user) — a full author/admin role system was
  // explicitly dropped from this pass.
  app.post("/problems", requireAuth, async (req, res) => {
    const { title, statement, timeLimitMs, testCases } = req.body ?? {};
    if (!title || !Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: "title and a non-empty testCases array are required" });
      return;
    }
    const id = await createProblem({ title, statement, timeLimitMs, testCases });
    res.status(201).json({ id });
  });

  app.get("/problems", async (_req, res) => {
    res.json(await listProblems());
  });

  app.get("/problems/:id", async (req, res) => {
    const problem = await getProblemPublic(Number(req.params.id));
    if (!problem) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(problem);
  });

  // this user's submissions for one problem (the "Submissions" tab)
  app.get("/problems/:id/submissions", requireAuth, async (req: AuthedRequest, res) => {
    res.json(await getUserSubmissionsForProblem(req.userId!, Number(req.params.id)));
  });

  // --- submissions -----------------------------------------------------

  const submissionLimiter = makeLimiter({
    windowMs: SUBMISSION_RATE_WINDOW_MS,
    max: SUBMISSION_RATE_MAX,
    message: "you're submitting too fast, please slow down",
    // Key on the authenticated user, not the IP — this runs after requireAuth,
    // and a shared campus/office NAT shouldn't rate-limit everyone together.
    keyGenerator: (req) => String((req as AuthedRequest).userId),
  });

  app.post("/submissions", requireAuth, submissionLimiter, async (req: AuthedRequest, res) => {
    const { problemId, language, sourceCode, stdin } = req.body ?? {};
    if (!problemId || !language || typeof sourceCode !== "string") {
      res.status(400).json({ error: "problemId, language, sourceCode are required" });
      return;
    }
    // Reject an unsupported language at the boundary. Without this the row is
    // created and enqueued, and the worker can't grade it — a poison message.
    if (!isLanguage(language)) {
      res.status(400).json({ error: "language must be one of: cpp, java, python" });
      return;
    }
    if (Buffer.byteLength(sourceCode, "utf8") > MAX_SOURCE_CODE_BYTES) {
      res.status(400).json({
        error: `sourceCode exceeds the ${MAX_SOURCE_CODE_BYTES}-byte limit`,
      });
      return;
    }
    const submissionId = await createSubmission({
      problemId,
      language,
      sourceCode,
      stdin,
      userId: req.userId,
    });

    if (DEMO_MODE) {
      await markSubmissionDemoDisabled(submissionId, DEMO_MESSAGE);
    } else {
      await enqueueSubmission(submissionId);
    }

    res.status(201).json({ submissionId, demoMode: DEMO_MODE });
  });

  // Scoped to the owner. Someone else's submission id returns 404, not 403, so
  // the status code doesn't confirm that the id exists.
  app.get("/submissions/:id", requireAuth, async (req: AuthedRequest, res) => {
    const submission = await getSubmissionForOwner(Number(req.params.id), req.userId!);
    if (!submission) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(submission);
  });

  // Body-parser errors (oversized or malformed JSON) land here as the last
  // middleware — turn them into a clean JSON 4xx instead of Express's default
  // HTML error page.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
    next(err);
  });

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
