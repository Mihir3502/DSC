// Serializable state shared by candidate auth forms and their server
// actions. Messages are composed on the server from closed result codes;
// state never contains passwords, tokens, codes, or account details.

export type AuthFormState = Readonly<{
  status: "idle" | "error" | "success";
  /** Summary message (error summary or success confirmation). */
  message?: string;
  /** Per-field messages keyed by input name. */
  fieldErrors?: Readonly<Record<string, string>>;
  /** Re-populated non-secret values (the email the user just typed). */
  values?: Readonly<{ email?: string }>;
  /** Increments on every submission so focus management can re-run. */
  attempt?: number;
}>;

export const initialAuthFormState: AuthFormState = Object.freeze({
  status: "idle",
});

export type AuthFormAction = (
  previous: AuthFormState,
  formData: FormData,
) => Promise<AuthFormState>;
