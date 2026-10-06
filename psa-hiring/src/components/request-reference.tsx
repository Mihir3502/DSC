"use client";

import { createContext, useContext, type ReactNode } from "react";

// Carries the current page request's correlation ID (from the root layout)
// to client error boundaries. It is an opaque reference only.

const RequestReferenceContext = createContext<string | undefined>(undefined);

export function RequestReferenceProvider({
  value,
  children,
}: {
  value: string | undefined;
  children: ReactNode;
}) {
  return (
    <RequestReferenceContext.Provider value={value}>
      {children}
    </RequestReferenceContext.Provider>
  );
}

export function useRequestReference(): string | undefined {
  return useContext(RequestReferenceContext);
}
