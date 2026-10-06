import type { LogContext } from "./log-context";

// Application-owned logger contract. Business code depends on this type,
// never on Pino. Messages are stable event codes; context is the typed
// allowlist only. There is deliberately no parameter for an Error, request,
// response, headers, ORM row, or arbitrary object.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppLogger {
  debug(eventCode: string, context?: LogContext): void;
  info(eventCode: string, context?: LogContext): void;
  warn(eventCode: string, context?: LogContext): void;
  error(eventCode: string, context?: LogContext): void;
  /** Returns a logger that adds bound context to every record. */
  child(context: LogContext): AppLogger;
}
