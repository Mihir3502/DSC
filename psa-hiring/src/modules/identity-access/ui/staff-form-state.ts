import type { StaffEnrollment } from "../application/activate-staff-account";
import type { AuthFormState } from "./form-state";

// Serializable state for staff authentication forms (packet M1.3 §16).
// The one-time enrollment key/QR and backup codes appear only in the state
// of the single step that displays them; they are never placed in a URL,
// title, client storage, or a later request.

export type EnrollmentDisplay = StaffEnrollment;

export type BeginActivationState = AuthFormState &
  Readonly<{ enrollment?: EnrollmentDisplay }>;

export type BackupCodesState = AuthFormState &
  Readonly<{ backupCodes?: readonly string[] }>;

export type StaffFormAction<S extends AuthFormState = AuthFormState> = (
  previous: S,
  formData: FormData,
) => Promise<S>;
