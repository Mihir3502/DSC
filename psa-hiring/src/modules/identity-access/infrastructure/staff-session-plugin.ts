import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

// Server-only session rotation for staff activation (packet M1.3 §9 step 11,
// ADR-0004). Activation ends inside an invitation-bound enrollment session;
// once the account is ACTIVE, this endpoint asks Better Auth to create a new
// session (the session-creation hook stamps STAFF assurance from the
// declared issuance intent), sets its signed cookie with Better Auth's own
// helper, and deletes the enrollment session. It is `serverOnly`, so it has
// no HTTP route, and it takes no body.

export function staffSessionPlugin() {
  return {
    id: "psa-staff-session",
    endpoints: {
      rotateStaffSession: createAuthEndpoint.serverOnly(
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const current = ctx.context.session;
          const next = await ctx.context.internalAdapter.createSession(
            current.user.id,
          );
          if (!next) throw new APIError("UNAUTHORIZED");
          await setSessionCookie(ctx, { session: next, user: current.user });
          await ctx.context.internalAdapter.deleteSession(
            current.session.token,
          );
          return ctx.json({ status: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
