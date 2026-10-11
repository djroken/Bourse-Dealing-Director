import type { CSSProperties } from "react";

/** Mono label/value style used all over the Desk. */
export function m(size: number, letterSpacing?: string, color?: string, extra?: CSSProperties): CSSProperties {
  return {
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    fontSize: size,
    ...(letterSpacing ? { letterSpacing } : null),
    ...(color ? { color } : null),
    ...extra,
  };
}
