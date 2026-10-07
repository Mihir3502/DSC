import { describe, expect, it } from "vitest";
import { defineFormSchema, parseFormInput } from "./form-input";

// Exact Server Action input and mass-assignment protection (packet M1.5
// §13, AC-M1.5-07).

const schema = defineFormSchema({
  currentPassword: { maxLength: 4096 },
  password: { maxLength: 4096 },
  passwordConfirmation: { maxLength: 4096 },
});

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
}

const valid: [string, string][] = [
  ["currentPassword", "TEST old passphrase 0001"],
  ["password", "TEST new passphrase 0002"],
  ["passwordConfirmation", "TEST new passphrase 0002"],
];

describe("parseFormInput", () => {
  it("accepts exactly the declared fields and distinguishes missing from empty", () => {
    const parsed = parseFormInput(form([["password", ""]]), schema);
    expect(parsed).toEqual({
      kind: "ACCEPTED",
      values: {
        currentPassword: undefined,
        password: "",
        passwordConfirmation: undefined,
      },
    });
    expect(parseFormInput(form(valid), schema).kind).toBe("ACCEPTED");
  });

  it.each([
    "accountType",
    "status",
    "emailVerified",
    "role",
    "roles",
    "roleCode",
    "permission",
    "permissionCode",
    "scope",
    "scopeReferenceId",
    "ownerAccountId",
    "accountId",
    "userId",
    "approverId",
    "authorizationVersion",
    "sensitivity",
    "workflowState",
    "assurance",
    "policyVersion",
    "projection",
    "select",
    "include",
    "fields",
    "redirect",
    "next",
    "callbackURL",
    "session[userId]",
    "user.accountType",
  ])(
    "rejects a submission carrying server-owned or selector field %s",
    (name) => {
      expect(parseFormInput(form([...valid, [name, "STAFF"]]), schema)).toEqual(
        {
          kind: "REJECTED",
          reason: "UNKNOWN_FIELD",
        },
      );
    },
  );

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the prototype-pollution key %s",
    (name) => {
      expect(parseFormInput(form([...valid, [name, "{}"]]), schema)).toEqual({
        kind: "REJECTED",
        reason: "RESERVED_KEY",
      });
    },
  );

  it("rejects repeated fields, files, over-long values, and floods", () => {
    expect(
      parseFormInput(form([...valid, ["password", "TEST other 0003"]]), schema),
    ).toMatchObject({ reason: "DUPLICATE_FIELD" });
    expect(
      parseFormInput(form([["password", new Blob(["x"])]]), schema),
    ).toMatchObject({ reason: "NON_STRING" });
    expect(
      parseFormInput(form([["password", "x".repeat(4097)]]), schema),
    ).toMatchObject({ reason: "TOO_LONG" });
    const flood = Array.from(
      { length: 40 },
      (_, i) => [`$ACTION_${i}:0`, "x"] as [string, string],
    );
    expect(parseFormInput(form(flood), schema)).toMatchObject({
      reason: "TOO_MANY_FIELDS",
    });
  });

  it("ignores only the framework's own $ACTION_* bookkeeping fields", () => {
    const parsed = parseFormInput(
      form([
        ...valid,
        ["$ACTION_REF_1", ""],
        ["$ACTION_1:0", '{"id":"x"}'],
        ["$ACTION_KEY", "k"],
      ]),
      schema,
    );
    expect(parsed.kind).toBe("ACCEPTED");
    expect(
      parseFormInput(form([...valid, ["$ACTION_REF_1\u0000", ""]]), schema)
        .kind,
    ).toBe("REJECTED");
    expect(
      parseFormInput(form([...valid, ["$ACTIONX", ""]]), schema).kind,
    ).toBe("REJECTED");
  });

  it("returns only declared keys (never the submitted object)", () => {
    const parsed = parseFormInput(form(valid), schema);
    expect(
      parsed.kind === "ACCEPTED" && Object.keys(parsed.values).sort(),
    ).toEqual(["currentPassword", "password", "passwordConfirmation"]);
    expect(parsed.kind === "ACCEPTED" && Object.isFrozen(parsed.values)).toBe(
      true,
    );
  });

  it("refuses unsafe schema field names at definition", () => {
    expect(() => defineFormSchema({ "user.role": { maxLength: 1 } })).toThrow();
    expect(() => defineFormSchema({ constructor: { maxLength: 1 } })).toThrow();
  });
});
