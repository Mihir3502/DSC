import {
  candidateActorFrom,
  newCandidateCommandKey,
} from "@/modules/candidates";
import {
  MAX_UPLOAD_REQUEST_BYTES,
  uploadApplicationAttachment,
} from "@/modules/documents";
import { withRouteHandler } from "@/shared/http/route-handler";

// Attachment upload (packet M2.5; ARCHITECTURE §5: uploads use Route Handlers
// because Server Actions are capped far below the file limit). The request must
// come from this origin and declare a bounded size before its body is read. The
// browser supplies only the key, category, optional replaced document, and the
// file. Responses are closed codes and never echo a name or contents.

const allowedFields = new Set(["commandKey", "category", "documentId", "file"]);

const json = (status: number, body: Readonly<Record<string, string>>) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const statusFor: Readonly<Record<string, number>> = {
  UNAUTHENTICATED: 401,
  NOT_AUTHORIZED: 404,
  NOT_FOUND: 404,
  COMMAND_KEY_CONFLICT: 409,
  STALE_VERSION: 409,
  INVALID_TRANSITION: 409,
  LIMIT_REACHED: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

export const POST = withRouteHandler(
  {
    routeTemplate:
      "/api/candidate/applications/[candidacyId]/attachments/upload",
  },
  async ({ request }) => {
    if (!isSameOrigin(request)) return json(403, { result: "FORBIDDEN" });
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isInteger(declared) || declared <= 0) {
      return json(411, { result: "LENGTH_REQUIRED" });
    }
    if (declared > MAX_UPLOAD_REQUEST_BYTES) {
      return json(413, { result: "TOO_LARGE" });
    }
    const actor = await candidateActorFrom(request.headers);
    if (!actor) return json(401, { result: "UNAUTHENTICATED" });
    const candidacyId = /\/applications\/([^/]+)\/attachments\/upload$/.exec(
      new URL(request.url).pathname,
    )?.[1];
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, { result: "INVALID_INPUT" });
    }
    const names = [...form.keys()];
    const file = form.get("file");
    if (
      names.some((name) => !allowedFields.has(name)) ||
      new Set(names).size !== names.length ||
      !(file instanceof File)
    ) {
      return json(400, { result: "INVALID_INPUT" });
    }
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const result = await uploadApplicationAttachment(
      {
        commandKey: text("commandKey") ?? newCandidateCommandKey(),
        candidacyId,
        category: text("category"),
        ...(text("documentId") ? { documentId: text("documentId") } : {}),
        fileName: file.name,
        declaredType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
      actor,
    );
    switch (result.kind) {
      case "RECEIVED":
        return json(result.status === "CLEAN" ? 200 : 202, {
          result: result.status,
        });
      case "INVALID_FILE":
        return json(422, { result: result.reason });
      case "REFUSED":
        return json(statusFor[result.reason] ?? 400, {
          result:
            result.reason === "NOT_AUTHORIZED" ? "NOT_FOUND" : result.reason,
        });
    }
  },
);
