import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { queryPublicPosition } from "@/modules/organization";

// Public detail of one opening (packet M2.1 §18). The route parameter is
// the hiring cycle's nonsequential public reference. Draft, published-not
// -open, cancelled, archived, never-opened, malformed, and unknown
// references all render the same not-found page; a formerly open opening
// that closed (or reached its exclusive closing time) shows one generic
// "no longer accepting" state with no reason or content. Availability is
// re-evaluated at request time; content is plain text rendered as escaped
// paragraphs and list items only.

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/positions/[positionId]">): Promise<Metadata> {
  const result = await queryPublicPosition((await params).positionId);
  return {
    title:
      result.kind === "FOUND" && result.view.availability === "ACCEPTING"
        ? result.view.title
        : "Position",
  };
}

export default async function PositionDetailPage({
  params,
}: PageProps<"/positions/[positionId]">) {
  const result = await queryPublicPosition((await params).positionId);
  if (result.kind !== "FOUND") notFound();
  const view = result.view;

  if (view.availability === "NO_LONGER_ACCEPTING") {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          This position is no longer accepting applications
        </h1>
        <p>
          <Link href="/positions" className="underline underline-offset-4">
            See positions that are open now
          </Link>
        </p>
      </div>
    );
  }

  return (
    <article className="flex max-w-3xl flex-col gap-6">
      <Link href="/positions" className="underline underline-offset-4">
        All open positions
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{view.title}</h1>
        <p className="text-muted-foreground">{view.location}</p>
        <p className="font-medium">Accepting applications</p>
        {view.closes ? <p>{view.closes}</p> : null}
      </header>
      <p className="text-lg">{view.summary}</p>
      <section aria-labelledby="about-heading" className="flex flex-col gap-3">
        <h2 id="about-heading" className="text-xl font-semibold">
          About this position
        </h2>
        {view.blocks.map((block, index) =>
          block.kind === "list" ? (
            <ul key={index} className="list-disc pl-6">
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : (
            <p key={index}>{block.text}</p>
          ),
        )}
      </section>
      <section
        aria-labelledby="arrangement-heading"
        className="flex flex-col gap-2"
      >
        <h2 id="arrangement-heading" className="text-xl font-semibold">
          Work arrangement
        </h2>
        <p>{view.workerPaths}</p>
        <p className="text-sm text-muted-foreground">{view.disclaimer}</p>
      </section>
      <div className="flex flex-col gap-2">
        <Link
          href={`/apply/${view.reference}`}
          className={`${buttonVariants({ variant: "default" })} self-start`}
        >
          Start application
        </Link>
        <p className="text-sm text-muted-foreground">
          You will sign in or create a candidate account first. Starting does
          not submit an application.
        </p>
      </div>
    </article>
  );
}
