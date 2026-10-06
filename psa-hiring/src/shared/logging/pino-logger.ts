import pino, { type DestinationStream, type LoggerOptions } from "pino";
import { toSafeLogFields, type LogContext } from "./log-context";
import type { AppLogger, LogLevel } from "./logger";
import { REDACT_MARKER, redactionPaths } from "./redaction";

// Pino adapter for the AppLogger contract. Output is always structured JSON
// (no pretty printer in any environment). Every record passes the field
// allowlist and redaction before serialization. Stacks, messages, and causes
// of errors are never logged.

const environments = new Set(["local", "test", "staging", "production"]);
const eventCodePattern = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Pino options shared by every logger; exported for redaction tests. */
export function pinoOptions(level: LogLevel = "info"): LoggerOptions {
  const appEnv = process.env.APP_ENV ?? "";
  return {
    level,
    base: {
      service: "psa-hiring",
      environment: environments.has(appEnv) ? appEnv : "unknown",
    },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => toSafeLogFields(object),
    },
    redact: { paths: redactionPaths, censor: REDACT_MARKER },
  };
}

function safeEventCode(eventCode: string): string {
  return eventCodePattern.test(eventCode) ? eventCode : "invalid.event_code";
}

function wrap(logger: pino.Logger): AppLogger {
  const write =
    (level: LogLevel) =>
    (eventCode: string, context: LogContext = {}) => {
      logger[level](toSafeLogFields(context), safeEventCode(eventCode));
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (context) => wrap(logger.child(toSafeLogFields(context))),
  };
}

/** Creates a logger. Tests pass an in-memory destination. */
export function createLogger(
  options: { destination?: DestinationStream; level?: LogLevel } = {},
): AppLogger {
  const instance = options.destination
    ? pino(pinoOptions(options.level), options.destination)
    : pino(pinoOptions(options.level));
  return wrap(instance);
}

let root: AppLogger | undefined;

/** The process-wide root logger (JSON to stdout), created on first use. */
export function getLogger(): AppLogger {
  root ??= createLogger();
  return root;
}
