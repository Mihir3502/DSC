import { guardNavigation } from "@/modules/identity-access/delivery/route-authorization";

// Staff account route group (packet M1.5 §8). Navigation convenience only:
// an anonymous or password-only (MFA-incomplete) browser goes to staff
// sign-in and a candidate or service principal sees the same safe
// not-found as an unknown page. Every page and action below authorizes
// again through its application query or command; nothing computed here
// is passed down or trusted.
export const dynamic = "force-dynamic";

export default async function StaffAccountLayout({
  children,
}: LayoutProps<"/staff">) {
  await guardNavigation("STAFF");
  return children;
}
