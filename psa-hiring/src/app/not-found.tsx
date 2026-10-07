import type { Metadata } from "next";
import { AccessState } from "@/components/security/access-state";

// The single safe not-found state (packet M1.5 §10.3, §19). Unknown routes,
// hidden surfaces (a principal of the other audience on a candidate/staff
// route group), and refused actions all render this same content with the
// same 404 status, so a response never confirms that something exists.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return <AccessState kind="not-found" />;
}
