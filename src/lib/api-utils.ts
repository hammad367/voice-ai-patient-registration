// ============================================================================
// REST API utilities — response envelope, error handling, rate limiting.
//
// Challenge API standards implemented here so every route shares them:
//   • Consistent JSON envelope: { "data": {...}, "error": null }
//   • Proper HTTP status codes: 200, 201, 400, 404, 422, 500
//   • Basic input sanitization (security requirement)
// ============================================================================

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "./logger";
import { ensureDatabaseReady } from "./db-bootstrap";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
export interface ApiEnvelope<T> {
  data: T | null;
  error: string | { message: string; details?: unknown } | null;
}

export function ok<T>(data: T, status: 200 | 201 = 200): NextResponse {
  return NextResponse.json<ApiEnvelope<T>>({ data, error: null }, { status });
}

export function fail(
  message: string,
  status: 400 | 404 | 409 | 422 | 429 | 500,
  details?: unknown
): NextResponse {
  return NextResponse.json<ApiEnvelope<never>>(
    { data: null, error: details === undefined ? { message } : { message, details } },
    { status }
  );
}

// ---------------------------------------------------------------------------
// ApiError — throw anywhere inside a route; handleRoute converts to envelope
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  status: 400 | 404 | 409 | 422 | 429 | 500;
  details?: unknown;
  constructor(message: string, status: 400 | 404 | 409 | 422 | 429 | 500 = 400, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps a route handler with uniform error → envelope mapping + logging. */
export function handleRoute(
  req: Request,
  path: string,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const started = Date.now();
  // Self-heal the database before the handler runs (no-op after the first
  // call per instance; NEVER blocks or fails a request on bootstrap errors).
  return ensureDatabaseReady()
    .catch(() => null)
    .then(() => handler())
    .then((res) => {
      logger.api(req.method, path, res.status, Date.now() - started);
      return res;
    })
    .catch((err) => {
      if (err instanceof ApiError) {
        logger.warn("http", `${req.method} ${path} → ${err.status}: ${err.message}`);
        logger.api(req.method, path, err.status, Date.now() - started);
        return fail(err.message, err.status, err.details);
      }
      if (err instanceof ZodError) {
        logger.api(req.method, path, 422, Date.now() - started);
        return fail("Validation failed.", 422, err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      }
      logger.error("http", `${req.method} ${path} → 500`, {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join("\n") : undefined,
      });
      logger.api(req.method, path, 500, Date.now() - started);
      return fail("Internal server error.", 500);
    });
}

// ---------------------------------------------------------------------------
// Body parsing — never trust the client
// ---------------------------------------------------------------------------
export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object") {
      throw new ApiError("Request body must be a JSON object.", 400);
    }
    return body;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("Invalid JSON in request body.", 400);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting — simple in-memory sliding window (per IP for the public API,
// per session for voice). Sufficient for a single-node deployment; swap for
// Redis when scaling horizontally (documented in README trade-offs).
// ---------------------------------------------------------------------------
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    // basic memory guard: drop stale buckets
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return true;
}

export function clientKey(req: Request, scope: string): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${scope}:${fwd || "local"}`;
}
