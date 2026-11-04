"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Certification and submission (packet M2.6 §12; UI_FLOW §7.4). Submitting asks
// for confirmation and explains that the application will be frozen. The key
// stays the same until the server answers, so a retry can't submit twice.

export function SubmitApplicationForm({
  action,
  candidacyId,
  commandKey,
  complete,
  accepting,
  statement,
  certificationVersion,
  reviewToken,
}: {
  action: (form: FormData) => Promise<{ ok: boolean; message?: string }>;
  candidacyId: string;
  commandKey: string;
  complete: boolean;
  accepting: boolean;
  statement: string;
  certificationVersion: number;
  reviewToken: string;
}) {
  const router = useRouter();
  const [certified, setCertified] = useState(false);
  const [signature, setSignature] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem]);

  if (!accepting) {
    return (
      <p role="status" className="rounded-lg border p-4">
        This position is no longer accepting applications, so this application
        can&apos;t be submitted. Your draft is saved.
      </p>
    );
  }
  if (!complete) {
    return (
      <p role="status" className="rounded-lg border p-4">
        Answer everything listed under &quot;Still needed&quot; before
        submitting.
      </p>
    );
  }

  const ready = certified && signature.trim().length >= 2;

  async function submit() {
    setBusy(true);
    setProblem(null);
    const data = new FormData();
    data.set("commandKey", commandKey);
    data.set("candidacyId", candidacyId);
    data.set("certificationVersion", String(certificationVersion));
    data.set("certified", "yes");
    data.set("signature", signature);
    data.set("reviewToken", reviewToken);
    try {
      const result = await action(data);
      if (result.ok) {
        router.push(`/candidate/applications/${candidacyId}/submitted`);
        return;
      }
      setConfirming(false);
      setProblem(result.message ?? "Your application wasn't submitted.");
    } catch (error) {
      const digest = (error as { digest?: unknown } | null)?.digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
      setConfirming(false);
      setProblem(
        "We couldn't confirm your submission. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="certify"
      className="flex flex-col gap-4 rounded-lg border p-4 print:hidden"
    >
      <h2 id="certify" className="text-xl font-semibold">
        Certify and submit
      </h2>
      {problem ? (
        <p
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-destructive p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {problem}
        </p>
      ) : null}
      <p>{statement}</p>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5 shrink-0"
          checked={certified}
          onChange={(event) => setCertified(event.target.checked)}
        />
        I certify the statement above.
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="signature" className="font-medium">
          Type your full name
        </label>
        <input
          id="signature"
          type="text"
          maxLength={200}
          autoComplete="off"
          value={signature}
          onChange={(event) => setSignature(event.target.value)}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p>
            Submit this application? It will be frozen, and you won&apos;t be
            able to change it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="lg"
              className="min-h-11"
              disabled={busy}
              autoFocus
              onClick={() => void submit()}
            >
              {busy ? "Submitting…" : "Confirm and submit"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep editing
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            size="lg"
            className="min-h-11"
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            Submit application
          </Button>
        </div>
      )}
    </section>
  );
}
