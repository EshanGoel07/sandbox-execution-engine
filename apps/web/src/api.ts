/**
 * Thin API client. Two deployment shapes:
 *  - local dev: VITE_API_URL unset -> talk to "/api" and "/ws", which
 *    vite.config.ts proxies to the API on :3000 (same-origin, no CORS).
 *  - built/deployed: VITE_API_URL="https://virtual-judge-api.onrender.com"
 *    -> talk to that host directly (CORS is enabled on the API).
 */
let RAW = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");
// Some hosts (Render's `fromService: host`) inject a bare hostname with no
// scheme — assume https for anything that isn't already absolute.
if (RAW && !/^https?:\/\//.test(RAW)) RAW = `https://${RAW}`;

export const API_BASE = RAW || "/api";

export const WS_URL = RAW
  ? RAW.replace(/^http/, "ws") + "/ws"
  : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

const TOKEN_KEY = "vj_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode / storage disabled — auth just won't persist */
  }
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ---------------------------------------------------------------------------
// Types — the wire contracts live in @vj/shared and are the same objects the
// API produces. The web client imports them exactly like a third-party
// consumer would; it never reaches into the API or engine source.
// ---------------------------------------------------------------------------

import type {
  ProblemListItem,
  ProblemDetail,
  TestResult,
  SubmissionDetail,
  SubmissionSummary,
  Profile,
} from "@vj/shared";

export type {
  ProblemListItem,
  ProblemDetail,
  TestResult,
  SubmissionDetail,
  SubmissionSummary,
  Profile,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (body as any).error || `${res.status} ${res.statusText}`);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const listProblems = () =>
  fetch(`${API_BASE}/problems`).then(json<ProblemListItem[]>);

export const getProblem = (id: number | string) =>
  fetch(`${API_BASE}/problems/${id}`).then(json<ProblemDetail>);

// GET /submissions/:id is auth'd and owner-scoped — send the token.
export const getSubmission = (id: number | string) =>
  fetch(`${API_BASE}/submissions/${id}`, { headers: authHeaders() }).then(json<SubmissionDetail>);

export const submit = (body: {
  problemId: number;
  language: string;
  sourceCode: string;
  stdin: string;
}) =>
  fetch(`${API_BASE}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  }).then(json<{ submissionId: number; demoMode: boolean }>);

// this user's submissions for one problem (for the "Submissions" tab)
export const getMyProblemSubmissions = (problemId: number | string) =>
  fetch(`${API_BASE}/problems/${problemId}/submissions`, { headers: authHeaders() }).then(
    json<SubmissionSummary[]>
  );

// --- auth ---

export const signup = (email: string, password: string) =>
  fetch(`${API_BASE}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).then(json<{ token: string; user: { id: number; email: string } }>);

export const login = (email: string, password: string) =>
  fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).then(json<{ token: string; user: { id: number; email: string } }>);

export const authMe = () =>
  fetch(`${API_BASE}/auth/me`, { headers: authHeaders() }).then(
    json<{ id: number; email: string }>
  );

export const getProfile = () =>
  fetch(`${API_BASE}/profile`, { headers: authHeaders() }).then(json<Profile>);

export { ApiError };
