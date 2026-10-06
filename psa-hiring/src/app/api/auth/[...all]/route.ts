import { handleAuthRequest } from "@/modules/identity-access";
import { withRouteHandler } from "@/shared/http/route-handler";

// Better Auth endpoints (sign-in, sign-out, session, verification). Generic
// sign-up is disabled in M1.1. Responses are sanitized by handleAuthRequest
// and every request gets the standard correlation/logging wrapper.

const handle = withRouteHandler(
  { routeTemplate: "/api/auth/[...all]" },
  ({ request, correlationId }) => handleAuthRequest(request, correlationId),
);

export const GET = handle;
export const POST = handle;
