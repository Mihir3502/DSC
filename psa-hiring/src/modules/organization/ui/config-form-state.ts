// Serializable state shared by the M2.1 configuration forms and their
// Server Actions. Messages are composed on the server from closed result
// codes. `values` re-populates only what this user just typed, so a
// validation or stale-version error never loses their input; it never
// carries another record's data.

export type ConfigFormState = Readonly<{
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Readonly<Record<string, string>>;
  values?: Readonly<Record<string, string>>;
  /** Same-origin staff path to open after a successful create. */
  next?: string;
  /** Increments on every submission so focus management can re-run. */
  attempt?: number;
}>;

export const initialConfigFormState: ConfigFormState = Object.freeze({
  status: "idle",
});

export type ConfigFormAction = (
  previous: ConfigFormState,
  formData: FormData,
) => Promise<ConfigFormState>;

/** Only staff position-administration paths may be opened from a state. */
export const configNextPattern =
  /^\/staff\/admin\/positions(?:\/[0-9a-f-]{36}(?:\/(?:descriptions|cycles)\/[0-9a-f-]{36})?)?$/;
