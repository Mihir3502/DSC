import { describe, expect, it } from "vitest";
import {
  APPLICATION_HANDOFF_TTL_SECONDS,
  RegistrationIntentRepository,
} from "./registration-intent-repository";

// M2.1 start-application handoff signer (ADR-0003 note; packet M2.1 §19,
// §30 item 15): purpose-separated, short-lived, bound to one public
// reference; tampered, expired, wrong-purpose, or foreign-secret tokens
// fail with one null result.

const settings = {
  secret: "TEST-handoff-secret-for-unit-tests-only-0000",
  publicTtlSeconds: 3600,
  invitationTtlSeconds: 86400,
};
const store = async () => {
  throw new Error("no store in this test");
};
const at = (iso: string) => () => new Date(iso);

describe("application handoff signer", () => {
  const issuer = new RegistrationIntentRepository(
    settings,
    store,
    at("2026-10-07T12:00:00Z"),
  );

  it("binds exactly one public reference and verifies within its lifetime", () => {
    const token = issuer.issueApplicationHandoff("k3m9x2p7q4ad");
    expect(issuer.verifyApplicationHandoff(token)).toBe("k3m9x2p7q4ad");
    expect(token).not.toMatch(/@|staff|candidate|role/i);
    const later = new RegistrationIntentRepository(
      settings,
      store,
      () =>
        new Date(
          Date.parse("2026-10-07T12:00:00Z") +
            (APPLICATION_HANDOFF_TTL_SECONDS - 1) * 1000,
        ),
    );
    expect(later.verifyApplicationHandoff(token)).toBe("k3m9x2p7q4ad");
  });

  it("refuses expired, tampered, foreign-secret, and malformed tokens", () => {
    const token = issuer.issueApplicationHandoff("k3m9x2p7q4ad");
    const expired = new RegistrationIntentRepository(
      settings,
      store,
      () =>
        new Date(
          Date.parse("2026-10-07T12:00:00Z") +
            APPLICATION_HANDOFF_TTL_SECONDS * 1000,
        ),
    );
    expect(expired.verifyApplicationHandoff(token)).toBeNull();
    const [part, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(part!, "base64url").toString()),
        ref: "zzzzzzzzzzzz",
      }),
    ).toString("base64url");
    expect(
      issuer.verifyApplicationHandoff(`${forged}.${signature}`),
    ).toBeNull();
    const foreign = new RegistrationIntentRepository(
      { ...settings, secret: "TEST-other-secret-for-unit-tests-only-00000" },
      store,
      at("2026-10-07T12:00:00Z"),
    );
    expect(foreign.verifyApplicationHandoff(token)).toBeNull();
    for (const bad of [
      "",
      "x",
      `${part}.`,
      "a.b.c",
      42,
      null,
      `${part}.${"A".repeat(43)}`,
    ]) {
      expect(issuer.verifyApplicationHandoff(bad), String(bad)).toBeNull();
    }
    expect(() => issuer.issueApplicationHandoff("../../etc")).toThrow();
  });

  it("keeps the handoff and registration-intent purposes apart", async () => {
    const intent = issuer.issuePublic();
    expect(issuer.verifyApplicationHandoff(intent)).toBeNull();
    const handoff = issuer.issueApplicationHandoff("k3m9x2p7q4ad");
    expect(await issuer.peek(handoff)).toBeNull();
  });
});
