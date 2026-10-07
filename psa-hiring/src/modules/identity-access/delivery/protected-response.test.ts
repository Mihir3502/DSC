import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  protectedDownloadHeaders,
  protectedJson,
  protectedProblem,
  safeDownloadFilename,
} from "./protected-response";

// Protected Route Handler responses (packet M1.5 §15, §17, §18): exact
// schemas, never-return refusal, private/no-store headers, safe problems,
// and safe download headers. No production handler uses these yet.

const correlationId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";
const schema = z.strictObject({ ref: z.string(), status: z.literal("ACTIVE") });

describe("protected JSON", () => {
  it("sends an exact-schema body with private/no-store headers", async () => {
    const response = protectedJson(
      schema,
      { ref: "abc", status: "ACTIVE" },
      correlationId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ ref: "abc", status: "ACTIVE" });
  });

  it("refuses unknown keys or never-return fields with a generic system problem", async () => {
    for (const body of [
      { ref: "abc", status: "ACTIVE", accountId: "x" },
      { ref: "abc", status: "ACTIVE", token: "TESTCANARY" },
      { ref: 1, status: "ACTIVE" },
    ]) {
      const response = protectedJson(schema, body, correlationId);
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("TESTCANARY");
      expect(JSON.parse(text)).toEqual({
        type: "about:blank",
        title: "Unable to complete the request",
        status: 500,
        code: "INTERNAL_ERROR",
        correlationId,
      });
    }
  });
});

describe("protected problems", () => {
  it.each([
    [{ kind: "AUTHENTICATION_REQUIRED" }, 401, "UNAUTHENTICATED"],
    [{ kind: "NOT_FOUND" }, 404, "NOT_FOUND"],
    [{ kind: "FORBIDDEN" }, 403, "FORBIDDEN"],
    [{ kind: "REAUTHENTICATION_REQUIRED" }, 403, "REAUTHENTICATION_REQUIRED"],
    [{ kind: "INVALID_INPUT" }, 400, "VALIDATION_FAILED"],
    [{ kind: "CONFLICT" }, 409, "CONFLICT"],
    [{ kind: "RATE_LIMITED" }, 429, "RATE_LIMITED"],
    [{ kind: "SYSTEM_ERROR" }, 500, "INTERNAL_ERROR"],
  ] as const)(
    "%j → %i %s with only registry fields",
    async (outcome, status, code) => {
      const response = protectedProblem(outcome, correlationId);
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0",
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "code",
        "correlationId",
        "status",
        "title",
        "type",
      ]);
      expect(body.code).toBe(code);
    },
  );
});

describe("protected downloads", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\x\\report.pdf", "report.pdf"],
    ["TEST report\r\nSet-Cookie: a=b.pdf", "TEST report__Set-Cookie_ a_b.pdf"],
    ['a"; filename="evil.html', "a__ filename__evil.html"],
    [".hidden", "hidden"],
    ["", "document"],
    [null, "document"],
    ["x".repeat(500), "x".repeat(100)],
  ])("sanitizes filename %j", (input, expected) => {
    expect(safeDownloadFilename(input)).toBe(expected);
  });

  it("sets attachment, nosniff, no-store, no-referrer, and a sandbox CSP", () => {
    const headers = protectedDownloadHeaders(
      "TEST clearance.pdf",
      "application/pdf",
    );
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(headers.get("content-disposition")).toBe(
      `attachment; filename="TEST clearance.pdf"; filename*=UTF-8''TEST%20clearance.pdf`,
    );
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("never declares an unapproved content type", () => {
    const headers = protectedDownloadHeaders("x.html", "text/html" as never);
    expect(headers.get("content-type")).toBe("application/octet-stream");
  });
});
