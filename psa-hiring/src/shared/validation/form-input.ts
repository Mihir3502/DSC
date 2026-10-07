// Exact Server Action form input (packet M1.5 §13, ADR-0011). Pure.
//
// Policy: every command declares the exact field names it accepts, each
// with a length bound. Security-sensitive inputs REJECT rather than strip:
// one unknown field (for example `accountType`, `status`, `role`,
// `permission`, `scope`, `ownerId`, `projection`, `select`, `redirect`), a
// repeated field, a file, an over-long value, or a prototype-pollution key
// rejects the whole submission before any command runs, so nothing is
// partially applied. Only React/Next.js's own `$ACTION_*` bookkeeping
// fields are ignored (a narrow, reviewed framework exclusion).
//
// Parsed values are explicit strings or `undefined` (field absent), so a
// command can tell a missing field from an intentionally empty one. The
// result is never passed to an ORM insert/update; commands map each field.

export type FormFieldSpec = Readonly<{ maxLength: number }>;
export type FormSchema = Readonly<Record<string, FormFieldSpec>>;

export type FormRejection =
  | "UNKNOWN_FIELD"
  | "RESERVED_KEY"
  | "DUPLICATE_FIELD"
  | "NON_STRING"
  | "TOO_LONG"
  | "TOO_MANY_FIELDS";

export type ParsedForm<S extends FormSchema> =
  | Readonly<{
      kind: "ACCEPTED";
      values: Readonly<{ [K in keyof S]: string | undefined }>;
    }>
  | Readonly<{ kind: "REJECTED"; reason: FormRejection }>;

/** React/Next.js progressive-enhancement action bookkeeping fields. */
const frameworkField = /^\$ACTION_[A-Za-z0-9_:]{1,80}$/;
const pollutionKeys = new Set(["__proto__", "constructor", "prototype"]);
const MAX_FIELDS = 32;

export function isFrameworkField(name: string): boolean {
  return frameworkField.test(name);
}

/** Minimal FormData surface (Web FormData or a test double). */
export type FormEntries = Pick<FormData, "entries">;

export function parseFormInput<S extends FormSchema>(
  form: FormEntries,
  schema: S,
): ParsedForm<S> {
  const reject = (reason: FormRejection): ParsedForm<S> =>
    Object.freeze({ kind: "REJECTED", reason });
  const values = new Map<string, string>();
  let count = 0;
  for (const [name, value] of form.entries()) {
    count += 1;
    if (count > MAX_FIELDS) return reject("TOO_MANY_FIELDS");
    if (isFrameworkField(name)) continue;
    if (pollutionKeys.has(name)) return reject("RESERVED_KEY");
    if (!Object.hasOwn(schema, name)) return reject("UNKNOWN_FIELD");
    if (values.has(name)) return reject("DUPLICATE_FIELD");
    if (typeof value !== "string") return reject("NON_STRING");
    if (value.length > schema[name].maxLength) return reject("TOO_LONG");
    values.set(name, value);
  }
  const out: Record<string, string | undefined> = {};
  for (const name of Object.keys(schema)) out[name] = values.get(name);
  return Object.freeze({
    kind: "ACCEPTED",
    values: Object.freeze(out) as { [K in keyof S]: string | undefined },
  });
}

/** Declares a reviewed form schema (frozen; names must be plain tokens). */
export function defineFormSchema<S extends FormSchema>(schema: S): S {
  for (const name of Object.keys(schema)) {
    if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(name) || pollutionKeys.has(name)) {
      throw new Error("invalid form field name");
    }
  }
  return Object.freeze(schema);
}
