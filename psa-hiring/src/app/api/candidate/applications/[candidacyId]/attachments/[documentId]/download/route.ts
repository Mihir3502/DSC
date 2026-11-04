import { openApplicationAttachment } from "@/modules/documents";
import { protectedDownloadHeaders } from "@/modules/identity-access/delivery/protected-response";
import { withRouteHandler } from "@/shared/http/route-handler";

// Attachment download (packet M2.5). Bytes are sent only for the candidate's
// own clean, current file, after its audit event commits. Unknown and
// not-owned references get the same 404. The stored key never leaves the
// server, and the file downloads rather than opening in this origin.

const pathPattern = /\/applications\/([^/]+)\/attachments\/([^/]+)\/download$/;

const empty = (status: number) =>
  new Response(null, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

export const GET = withRouteHandler(
  {
    routeTemplate:
      "/api/candidate/applications/[candidacyId]/attachments/[documentId]/download",
  },
  async ({ request, correlationId }) => {
    const [, candidacyId, documentId] =
      pathPattern.exec(new URL(request.url).pathname) ?? [];
    const result = await openApplicationAttachment(
      request.headers,
      candidacyId,
      documentId,
      correlationId,
    );
    switch (result.kind) {
      case "OK":
        return new Response(Buffer.from(result.bytes), {
          status: 200,
          headers: protectedDownloadHeaders(result.name, result.mediaType),
        });
      case "UNAUTHENTICATED":
        return empty(401);
      case "UNAVAILABLE":
        return empty(409);
      case "RATE_LIMITED":
        return empty(429);
      case "NOT_FOUND":
        return empty(404);
    }
  },
);
