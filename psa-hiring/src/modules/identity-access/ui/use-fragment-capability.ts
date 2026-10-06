"use client";

import { useEffect, useRef, useState } from "react";

// Reads a one-time capability (reset token or invitation intent) from the
// URL fragment, then removes the fragment from the address bar and browser
// history before any interactive content renders (packet M1.2 §9.2).
// Fragments are never sent to the server or in Referer headers, so the
// capability does not reach access logs. It stays in memory only.

const capabilityShape = /^[A-Za-z0-9_-]{16,128}$/;

export type FragmentCapability =
  { ready: false; value: null } | { ready: true; value: string | null };

export function useFragmentCapability(
  name: "token" | "intent",
): FragmentCapability {
  const [state, setState] = useState<FragmentCapability>({
    ready: false,
    value: null,
  });
  // Captured once per component instance: effects may run twice (React
  // Strict Mode) and the fragment is already gone the second time.
  const captured = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (captured.current === undefined) {
      const { hash, pathname, search } = window.location;
      const raw = new URLSearchParams(hash.replace(/^#/, "")).get(name);
      if (hash) {
        window.history.replaceState(
          window.history.state,
          "",
          pathname + search,
        );
      }
      captured.current = raw && capabilityShape.test(raw) ? raw : null;
    }
    // Reading browser-only state after hydration is the purpose here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ ready: true, value: captured.current });
  }, [name]);
  return state;
}
