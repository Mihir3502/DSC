"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApplicationAttachmentsView } from "../presentation/document-views";

// Upload, replace, download, and remove (packet M2.5 §8, §12). Messages come
// from closed result codes. Nothing about a file goes to browser storage, and
// a failed upload leaves the selection in place so it can be retried.

const uploadMessages: Readonly<Record<string, string>> = {
  PENDING: "We received your file and are checking it.",
  REJECTED:
    "This file wasn't accepted because it may be unsafe. Choose a different file.",
  FAILED:
    "We couldn't check this file right now, so it isn't available. Try again later.",
  EMPTY: "This file is empty. Choose a different file.",
  TOO_LARGE: "This file is larger than 10 MB. Choose a smaller file.",
  TYPE_NOT_ALLOWED: "Choose a PDF, JPEG, or PNG file.",
  CONTENT_MISMATCH:
    "This file's contents don't match its type. Choose a PDF, JPEG, or PNG file.",
  LIMIT_REACHED:
    "You've reached the limit of 10 attachments. Remove one before adding another.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes, then try again.",
  UNAVAILABLE: "Uploads aren't available right now. Please try again later.",
  INVALID_TRANSITION: "This application can no longer be edited.",
};
const generalProblem =
  "Your file could not be uploaded. Reload the page and try again.";

const problemText = {
  NOT_ACCEPTED: "Your latest upload wasn't accepted because it may be unsafe.",
  NOT_CHECKED: "We couldn't check your latest upload, so it isn't available.",
} as const;

export function AttachmentPanel({
  view,
  categories,
  commandKey,
  removeAction,
}: {
  view: ApplicationAttachmentsView;
  categories: Readonly<Record<string, string>>;
  commandKey: string;
  removeAction: (form: FormData) => Promise<{ ok: boolean; message?: string }>;
}) {
  const router = useRouter();
  const base = `/api/candidate/applications/${view.candidacyId}/attachments`;
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const uploadKey = useRef(commandKey);
  const [category, setCategory] = useState(Object.keys(categories)[0] ?? "");
  const [replacing, setReplacing] = useState<Readonly<{
    id: string;
    name: string;
  }> | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem]);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setProblem("Choose a file to upload.");
      return;
    }
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const data = new FormData();
    data.set("commandKey", uploadKey.current);
    data.set("category", category);
    if (replacing) data.set("documentId", replacing.id);
    data.set("file", file);
    try {
      const response = await fetch(`${base}/upload`, {
        method: "POST",
        body: data,
      });
      if (response.status === 401) {
        router.push("/sign-in");
        return;
      }
      const { result } = (await response.json()) as { result?: string };
      // Anything the server answered is final for this key.
      uploadKey.current = crypto.randomUUID();
      if (result === "CLEAN") {
        form.current?.reset();
        setReplacing(null);
        setNotice("Your file was uploaded and is ready.");
      } else if (result === "PENDING") {
        form.current?.reset();
        setReplacing(null);
        setNotice(uploadMessages.PENDING!);
      } else {
        setProblem(uploadMessages[result ?? ""] ?? generalProblem);
      }
      router.refresh();
    } catch {
      // No answer: keep the key, so a retry can't apply twice.
      setProblem(
        "We couldn't reach the server. Your file wasn't confirmed. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(documentId: string, version: number) {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const data = new FormData();
    data.set("commandKey", crypto.randomUUID());
    data.set("candidacyId", view.candidacyId);
    data.set("documentId", documentId);
    data.set("expectedVersion", String(version));
    try {
      const result = await removeAction(data);
      if (result.ok) setNotice("The file was removed from your application.");
      else setProblem(result.message ?? generalProblem);
      setConfirming(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
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
      <p role="status" className="min-h-6 text-sm">
        {busy ? "Working on it…" : notice}
      </p>

      <section aria-labelledby="your-files" className="flex flex-col gap-3">
        <h2 id="your-files" className="text-xl font-semibold">
          Your files
        </h2>
        {view.attachments.length === 0 ? (
          <p>You haven&apos;t added any files yet.</p>
        ) : (
          <ul aria-labelledby="your-files" className="flex flex-col gap-3">
            {view.attachments.map((file) => (
              <li
                key={file.documentId}
                className="flex flex-col gap-2 rounded-lg border p-4 [overflow-wrap:anywhere]"
              >
                <h3 className="font-semibold">{file.name}</h3>
                <p className="text-sm">
                  {file.category} · {file.size}
                </p>
                <p className="text-sm">
                  Status: <span className="font-medium">{file.status}</span>
                </p>
                {file.problem ? (
                  <p className="text-sm">
                    {problemText[file.problem]}
                    {file.downloadable
                      ? " Your earlier file is still on your application."
                      : ""}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {file.downloadable ? (
                    <a
                      href={`${base}/${file.documentId}/download`}
                      className="inline-flex min-h-11 items-center underline underline-offset-4"
                    >
                      Download
                      <span className="sr-only"> {file.name}</span>
                    </a>
                  ) : null}
                  {view.editable ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => {
                        setReplacing({ id: file.documentId, name: file.name });
                        fileInput.current?.focus();
                      }}
                    >
                      Replace
                      <span className="sr-only"> {file.name}</span>
                    </Button>
                  ) : null}
                  {view.editable && confirming !== file.documentId ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => setConfirming(file.documentId)}
                    >
                      Remove
                      <span className="sr-only"> {file.name}</span>
                    </Button>
                  ) : null}
                </div>
                {confirming === file.documentId ? (
                  <div className="flex flex-col gap-2 rounded-lg border p-3">
                    <p>
                      Remove this file from your application? You&apos;ll need
                      to upload it again to add it back.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={busy}
                        autoFocus
                        onClick={() =>
                          void remove(file.documentId, file.version)
                        }
                      >
                        Confirm removal
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        Keep this file
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!view.editable ? (
        <p>This application can&apos;t be changed right now.</p>
      ) : view.atLimit && !replacing ? (
        <p>
          You&apos;ve reached the limit of 10 attachments. Remove one before
          adding another.
        </p>
      ) : (
        <form
          ref={form}
          onSubmit={upload}
          noValidate
          className="flex flex-col gap-4 rounded-lg border p-4"
        >
          <h2 className="text-xl font-semibold">
            {replacing ? "Replace a file" : "Add a file"}
          </h2>
          {replacing ? (
            <p className="[overflow-wrap:anywhere]">
              Replacing {replacing.name}. The current file stays on your
              application until the new one passes its checks.{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                onClick={() => setReplacing(null)}
              >
                Cancel replacing
              </Button>
            </p>
          ) : (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">What is this file?</legend>
              {Object.entries(categories).map(([value, label]) => (
                <label key={value} className="flex min-h-11 items-center gap-3">
                  <input
                    type="radio"
                    name="category"
                    value={value}
                    checked={category === value}
                    className="size-5 shrink-0"
                    onChange={() => setCategory(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="attachment-file" className="font-medium">
              Choose a file
            </label>
            <input
              ref={fileInput}
              id="attachment-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="max-w-full"
            />
          </div>
          <div>
            <Button
              type="submit"
              size="lg"
              className="min-h-11"
              disabled={busy}
            >
              {busy ? "Uploading…" : "Upload file"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
