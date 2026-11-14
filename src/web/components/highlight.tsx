import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONES = {
  primary: { pill: "bg-primary/15 ring-primary/25", color: "var(--primary)" },
  success: { pill: "bg-success/12 ring-success/25", color: "var(--success)" },
  danger: { pill: "bg-danger/12 ring-danger/25", color: "var(--danger)" },
} as const;

/**
 * The hero highlight from nimu-outreach's landing page: a tinted, ringed pill whose text carries a slow
 * light sweep. `serif` keeps nimu's italic Georgia treatment; turn it off for versions and identifiers.
 */
export function Highlight({ children, tone = "primary", serif = true, className }: { children: ReactNode; tone?: keyof typeof TONES; serif?: boolean; className?: string }) {
  const t = TONES[tone];
  return (
    <span className={cn("inline-flex items-center rounded-2xl px-2.5 py-0.5 align-baseline whitespace-nowrap ring-1 sm:px-3", t.pill, className)}>
      <span
        className={cn("shimmer-text", serif && "italic")}
        style={{ "--shimmer": t.color, ...(serif ? { fontFamily: 'Georgia, "Times New Roman", serif' } : {}) } as CSSProperties}
      >
        {children}
      </span>
    </span>
  );
}
