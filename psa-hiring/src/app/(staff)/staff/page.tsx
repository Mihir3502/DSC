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
  title: "Staff Portal",
};

export default function StaffPortalPage() {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-semibold tracking-tight">Staff Portal</h1>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Not yet available</h2>
          </CardTitle>
          <CardDescription>
            Foundation build only. No candidate or operational data is shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p>
            Staff accounts are invitation-only and require two-step
            verification.{" "}
            <Link
              href="/staff/sign-in"
              className="font-medium text-primary underline underline-offset-4"
            >
              Staff sign in
            </Link>
            . Work queues and records will be added in later work items.
          </p>
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
