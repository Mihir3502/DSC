// Serializable results of the application-draft Server Actions. Messages
// are composed on the server from closed result codes and never echo what
// the candidate typed.

export type BeginDraftState = Readonly<{
  status: "idle" | "error" | "success";
  message?: string;
  next?: string;
  attempt?: number;
}>;

export const initialBeginDraftState: BeginDraftState = Object.freeze({
  status: "idle",
});

export type SaveSectionState =
  | Readonly<{
      status: "saved";
      version: number;
      sectionStatus: string;
      lastSaved: string | null;
    }>
  | Readonly<{
      status: "invalid" | "conflict" | "error";
      message: string;
      fieldErrors?: Readonly<Record<string, string>>;
    }>;

/** Only an application overview or section may be opened after a command. */
export const applicationNextPattern =
  /^\/candidate\/applications\/[0-9a-hjkmnp-tv-z]{12}(?:\/[a-z][a-z_]{1,39})?$/;
