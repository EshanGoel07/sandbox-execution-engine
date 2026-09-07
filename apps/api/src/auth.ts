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
const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
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

// Express middleware: 401s unless a valid, unexpired token is present, and
// otherwise sets req.userId for the handler.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET as string) as { sub: number | string };
    req.userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: "invalid or expired session" });
  }
}
