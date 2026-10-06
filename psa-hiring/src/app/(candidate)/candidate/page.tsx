import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Candidate Portal",
};

export default function CandidatePortalPage() {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-semibold tracking-tight">
        Candidate Portal
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Your candidate account</h2>
          </CardTitle>
          <CardDescription>
            Create a candidate account or sign in. Applications and hiring tasks
            will be added in later work items.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <nav aria-label="Candidate account" className="flex flex-wrap gap-3">
            <Link href="/register" className={buttonVariants({ size: "lg" })}>
              Create a candidate account
            </Link>
            <Link
              href="/sign-in"
              className={buttonVariants({ size: "lg", variant: "outline" })}
            >
              Sign in
            </Link>
          </nav>
        </CardContent>
      </Card>

      <p>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to home
        </Link>
      </p>
    </div>
  );
}
