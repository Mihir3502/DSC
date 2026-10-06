// Server-side logging surface. Client components may import only
// `correlation.ts` (pure); this index pulls in Node-only modules.
export {
  CORRELATION_HEADER,
  generateCorrelationId,
  isValidCorrelationId,
  resolveCorrelationId,
} from "./correlation";
export { toHttpMethod, type HttpMethod, type LogContext } from "./log-context";
export type { AppLogger, LogLevel } from "./logger";
export { createLogger, getLogger } from "./pino-logger";
export { REDACT_MARKER } from "./redaction";
export {
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "./request-context";
