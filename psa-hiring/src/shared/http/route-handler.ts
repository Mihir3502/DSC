import "server-only";
import { normalizeError, toPublicError, type PublicProblem } from "../errors";
import {
  CORRELATION_HEADER,
  getLogger,
  resolveCorrelationId,
  runWithRequestContext,
  toHttpMethod,
  type AppLogger,
} from "../logging";

// Delivery adapter for Next.js route handlers (Web Request/Response only).
// Resolves the correlation ID, runs the handler in a request context, logs
// one completion or failure record from observed status and measured
// duration, and maps thrown errors to safe problem responses. It never logs
// or echoes the request body, headers, query string, cookies, or full URL.

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export type RouteContext = { request: Request; correlationId: string };
export type RouteHandler = (context: RouteContext) => Promise<Response>;

export function problemResponse(problem: PublicProblem): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: {
      "content-type": PROBLEM_CONTENT_TYPE,
      "cache-control": "no-store",
      [CORRELATION_HEADER]: problem.correlationId,
    },
  });
}

function withCorrelationHeader(
  response: Response,
  correlationId: string,
): Response {
  try {
    response.headers.set(CORRELATION_HEADER, correlationId);
    return response;
  } catch {
    // Some responses (e.g. Response.redirect) have immutable headers.
    const copy = new Response(response.body, response);
    copy.headers.set(CORRELATION_HEADER, correlationId);
    return copy;
  }
}

export function withRouteHandler(
  options: { routeTemplate: string; logger?: AppLogger },
  handler: RouteHandler,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const started = performance.now();
    const correlationId = resolveCorrelationId(
      request.headers.get(CORRELATION_HEADER),
    );
    const log = (options.logger ?? getLogger()).child({
      correlationId,
      routeTemplate: options.routeTemplate,
      method: toHttpMethod(request.method),
    });
    const elapsed = () => Math.round(performance.now() - started);

    return runWithRequestContext({ correlationId }, async () => {
      let response: Response;
      try {
        response = await handler({ request, correlationId });
      } catch (error) {
        const problem = toPublicError(error, correlationId);
        log.error("request.failed", {
          errorCode: normalizeError(error).code,
          statusCode: problem.status,
          durationMs: elapsed(),
        });
        return problemResponse(problem);
      }
      log.info("request.completed", {
        statusCode: response.status,
        durationMs: elapsed(),
      });
      return withCorrelationHeader(response, correlationId);
    });
  };
}
