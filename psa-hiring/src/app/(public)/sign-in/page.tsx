import type { Metadata } from "next";
import { AuthPage } from "@/modules/identity-access/ui/auth-page";
import { SignInForm } from "@/modules/identity-access/ui/candidate-auth-forms";
import { signInAction } from "../auth-actions";

export const metadata: Metadata = { title: "Candidate sign in" };
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  // Only a continuation key shape is passed through; the server resolves it
  // against the closed registry and ignores anything else.
  const { next } = await searchParams;
  const key =
    typeof next === "string" && /^[A-Z_]{1,40}$/.test(next) ? next : undefined;
  return (
    <AuthPage
      title="Candidate sign in"
      intro={
        <p>Sign in to your candidate account. Staff use a separate sign-in.</p>
      }
    >
      <SignInForm action={signInAction} next={key} />
    </AuthPage>
  );
}
