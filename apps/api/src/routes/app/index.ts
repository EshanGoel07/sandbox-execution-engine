/**
 * The judge web client's tree, mounted at /app. Session (JWT) auth.
 *
 * These handlers are the pre-existing judge API, moved here unchanged when
 * the public /api/v1 tree was added alongside. Error bodies in this tree stay
 * `{ error: "message" }` — the shape the web client reads.
 */
import express, { NextFunction, Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { isLanguage } from "@vj/shared";
import {
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
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  AuthedRequest,
} from "../../auth/session";
import {
  DEMO_MODE,
  JSON_BODY_LIMIT,
  MAX_SOURCE_CODE_BYTES,
  SIGNUP_RATE_WINDOW_MS,
  SIGNUP_RATE_MAX,
  LOGIN_RATE_WINDOW_MS,
  LOGIN_RATE_MAX,
  SUBMISSION_RATE_WINDOW_MS,
  SUBMISSION_RATE_MAX,
} from "../../config";
import { apiKeysRouter } from "./api-keys";

const DEMO_MESSAGE =
  "Sandbox execution is disabled in this public demo — arbitrary code " +
  "execution isn't safe to expose on free shared hosting without a " +
  "dedicated Docker host. Your submission was still stored. Run the full " +
  "stack locally with `docker compose up` (see the README) for real " +
  "judging, or watch the demo video.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    // We set Express's own `trust proxy` deliberately from TRUST_PROXY (see
    // api-server.ts); don't let the limiter second-guess that choice at first
    // request.
    validate: { trustProxy: false },
    handler: (_req, res) => {
      res.status(429).json({ error: opts.message });
    },
  });
}

export function appRouter(): Router {
  const app = Router();

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

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

  // --- API key management (session auth; the keys themselves are for /api/v1) ---

  app.use(apiKeysRouter());

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
