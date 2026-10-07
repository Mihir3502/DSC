import "server-only";
import type { z } from "zod";
import { publicErrorRegistry } from "@/shared/errors";
import { CORRELATION_HEADER } from "@/shared/logging";
import { PROBLEM_CONTENT_TYPE } from "@/shared/http/route-handler";
import {
  applyProtectedHeaders,
  PROTECTED_CACHE_CONTROL,
} from "@/shared/security/protected-cache-policy";
import { findNeverReturnKeys } from "../presentation/field-policy";
import {
  publicCodeForOutcome,
  type DeliveryOutcome,
} from "./authorization-error-mapper";

// Protected Route Handler responses (packet M1.5 §12.2, §15, §17, §18).
// Every protected JSON body is validated against its exact contract
// schema, scanned for never-return keys, and sent with private/no-store
// headers. Failures never leak: they become the generic system problem.

function problem(outcome: DeliveryOutcome, correlationId: string): Response {
  const code = publicCodeForOutcome(outcome);
  const { status, title } = publicErrorRegistry[code];
  const headers = new Headers({
    "content-type": PROBLEM_CONTENT_TYPE,
    [CORRELATION_HEADER]: correlationId,
    "x-content-type-options": "nosniff",
  });
  applyProtectedHeaders(headers);
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code, correlationId }),
    { status, headers },
  );
}

/** Safe problem response for a typed delivery outcome. */
export function protectedProblem(
  outcome: DeliveryOutcome,
  correlationId: string,
): Response {
  return problem(outcome, correlationId);
}

/** Exact-schema protected JSON response; refuses anything else. */
export function protectedJson<O>(
  schema: z.ZodType<O>,
  body: unknown,
  correlationId: string,
  status = 200,
): Response {
  const parsed = schema.safeParse(body);
  if (!parsed.success || findNeverReturnKeys(parsed.data).length > 0) {
    return problem({ kind: "SYSTEM_ERROR" }, correlationId);
  }
  const headers = new Headers({
    "content-type": "application/json",
    [CORRELATION_HEADER]: correlationId,
    "x-content-type-options": "nosniff",
  });
  applyProtectedHeaders(headers);
  return new Response(JSON.stringify(parsed.data), { status, headers });
}

const unsafeFilenameCharacters = /[^A-Za-z0-9._ -]/g;

/** A display filename safe for Content-Disposition (no path, no control). */
export function safeDownloadFilename(name: unknown, fallback = "document") {
  const base =
    typeof name === "string" ? (name.split(/[\\/]/).pop() ?? "") : "";
  const cleaned = base
    .normalize("NFKC")
    .replace(unsafeFilenameCharacters, "_")
    .replace(/^[.\s_]+/, "")
    .slice(0, 100)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Content types a protected download may declare (closed set). */
export const downloadContentTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;
export type DownloadContentType = (typeof downloadContentTypes)[number];

/**
 * Headers for an authorized, streamed protected download: attachment
 * disposition with a sanitized filename, a closed content type, nosniff,
 * no caching, no referrer, and a sandboxing CSP.
 */
export function protectedDownloadHeaders(
  filename: unknown,
  contentType: DownloadContentType,
): Headers {
  const name = safeDownloadFilename(filename);
  const headers = new Headers({
    "content-type": (downloadContentTypes as readonly string[]).includes(
      contentType,
    )
      ? contentType
      : "application/octet-stream",
    "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": PROTECTED_CACHE_CONTROL,
  });
  applyProtectedHeaders(headers);
  return headers;
}
