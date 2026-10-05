import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function PublicHomePage() {
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="page-title" className="flex flex-col gap-3">
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight">
          PSA Workforce Hiring System
        </h1>
        <p className="text-lg text-muted-foreground">
          Manages hiring for a private-pay Personal Services Agency, from
          candidate intake through Ready for Assignment.
        </p>
      </section>

      <nav aria-label="Portals" className="flex flex-wrap gap-3">
        <Link href="/candidate" className={buttonVariants({ size: "lg" })}>
          Candidate Portal
        </Link>
        <Link
          href="/staff"
          className={buttonVariants({ size: "lg", variant: "outline" })}
        >
          Staff Portal
        </Link>
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Foundation build</h2>
          </CardTitle>
          <CardDescription>
            This is a local foundation build. It contains no real personal
            information and collects none.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p>
            Sign-in, applications, and hiring workflows will be added in later
            work items.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
