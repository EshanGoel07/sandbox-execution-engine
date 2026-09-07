/**
 * Password hashing (bcrypt) + stateless JWT auth for the API.
 *
 * JWT rather than server sessions because the frontend is served from a
 * different origin than the API in the deployed demo — a bearer token in the
 * Authorization header sidesteps cross-site cookie friction. The token
 * carries only the user id; everything else is looked up from Postgres.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

// No fallback, anywhere. A hardcoded default secret that survives to
// production is how you end up with forgeable tokens — so the process
// refuses to start without one.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is not set. Refusing to start — without it, auth tokens would be signed " +
      "with a known key and could be forged by anyone. Set JWT_SECRET to a long random " +
      "string (see .env.example)."
  );
}

const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
// 12 rounds ~ 250ms/hash on current hardware: enough to make offline cracking
// of a leaked hash table expensive, still cheap enough for a login request.
const BCRYPT_ROUNDS = 12;

// A real bcrypt hash of a fixed throwaway string. `verifyPassword` runs a
// compare against this when the account doesn't exist, so login takes the
// same time whether or not the email is registered — no timing oracle for
// user enumeration. Generated with bcrypt.hashSync("no-such-user", 12).
const DUMMY_HASH = "$2a$12$Vhq29TyWdVNYxOZje9XOhus7QFd4Fm/4RwLWo5lSioFfMG.UeCKjC";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

// Pass hash = null when the user was not found: this still spends a full
// bcrypt compare (against a dummy hash) and returns false, so an absent email
// is indistinguishable by response time from a wrong password.
export function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (hash === null) {
    return bcrypt.compare(plain, DUMMY_HASH).then(() => false);
  }
  return bcrypt.compare(plain, hash);
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET as string, { expiresIn: JWT_TTL_SECONDS });
}

export interface AuthedRequest extends Request {
  userId?: number;
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

// Verify a token and return its user id, or null if it is missing, malformed,
// expired, or signed with anything other than HS256. Pinning the algorithm
// stops an "alg: none" / algorithm-confusion forgery — without it, jsonwebtoken
// would accept any algorithm the token's header claims.
export function verifyToken(token: string | null | undefined): number | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET as string, {
      algorithms: ["HS256"],
    }) as { sub: number | string };
    return Number(payload.sub);
  } catch {
    return null;
  }
}

// Express middleware: 401s unless a valid, unexpired token is present, and
// otherwise sets req.userId for the handler.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const userId = verifyToken(bearerToken(req));
  if (userId === null) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  req.userId = userId;
  next();
}
