import { guardNavigation } from "@/modules/identity-access/delivery/route-authorization";

// Candidate account route group (packet M1.5 §8). Navigation convenience
// only: an anonymous browser goes to candidate sign-in and a staff or
// service principal sees the same safe not-found as an unknown page. Every
// page and action below authorizes again through its application query or
// command; nothing computed here is passed down or trusted.
export const dynamic = "force-dynamic";

export default async function CandidateAccountLayout({
  children,
}: LayoutProps<"/candidate">) {
  await guardNavigation("CANDIDATE");
  return children;
}
