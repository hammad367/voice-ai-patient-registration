// ============================================================================
// Structured logger — observability requirement.
// Every agent conversation is logged (at minimum the final collected payload)
// to stdout, plus API request/error logs, all with ISO timestamps.
// ============================================================================

type Level = "info" | "warn" | "error" | "voice" | "api";

function emit(level: Level, scope: string, message: string, meta?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else console.log(serialized);
}

export const logger = {
  info: (scope: string, message: string, meta?: unknown) => emit("info", scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => emit("warn", scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => emit("error", scope, message, meta),
  /** Voice-agent turn logging: caller utterance + agent reply + extracted data */
  voice: (sessionId: string, message: string, meta?: unknown) => emit("voice", sessionId, message, meta),
  /** API request lifecycle logging */
  api: (method: string, path: string, status: number, ms: number) =>
    emit("api", "http", `${method} ${path} ${status} ${ms}ms`),
};
