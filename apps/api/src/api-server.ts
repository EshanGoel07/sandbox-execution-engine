import express from "express";
import http from "http";
import {
  runMigrations,
  createProblem,
  listProblems,
  getProblemPublic,
  createSubmission,
  getSubmissionWithResults,
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

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json());

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

  app.post("/auth/signup", async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "password must be at least 8 characters" });
      return;
    }
    if (await getUserByEmail(email)) {
      res.status(409).json({ error: "an account with that email already exists" });
      return;
    }
    const user = await createUser(email, await hashPassword(password));
    res.status(201).json({
      token: signToken(user.id),
      user: { id: user.id, email: user.email },
    });
  });

  app.post("/auth/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    const user = await getUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
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

  app.post("/problems", async (req, res) => {
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

  app.post("/submissions", requireAuth, async (req: AuthedRequest, res) => {
    const { problemId, language, sourceCode, stdin } = req.body ?? {};
    if (!problemId || !language || typeof sourceCode !== "string") {
      res.status(400).json({ error: "problemId, language, sourceCode are required" });
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

  app.get("/submissions/:id", async (req, res) => {
    const submission = await getSubmissionWithResults(Number(req.params.id));
    if (!submission) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(submission);
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
