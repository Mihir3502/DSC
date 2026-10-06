import type { ReactNode } from "react";

// Shared page frame for candidate authentication screens: one h1, a short
// plain-language introduction, and the form (packet M1.2 §14).

export function AuthPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {intro ? <div className="text-muted-foreground">{intro}</div> : null}
      </div>
      {children}
    </div>
  );
}
