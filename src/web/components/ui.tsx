import { CircleNotch } from "@phosphor-icons/react";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Primitives follow nimu-outreach's components/ui so both apps read as one product family. */

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-border bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 py-1.5",
        sm: "h-8 px-2.5",
        lg: "h-10 px-6",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, type = "button", ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

type Tone = "neutral" | "danger" | "warning" | "success" | "info";

const TONE_PILL: Record<Tone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  danger: { pill: "bg-danger-soft text-danger", dot: "bg-danger" },
  warning: { pill: "bg-warning-soft text-warning", dot: "bg-warning" },
  success: { pill: "bg-success-soft text-success", dot: "bg-success" },
  info: { pill: "bg-info-soft text-info", dot: "bg-info" },
};

/** Status pill in the shape of nimu-outreach's StatusPill: rounded-full, 11px, tinted, leading dot. */
export function Badge({
  className,
  tone = "neutral",
  dot = false,
  pulse = false,
  children,
  ...props
}: ComponentProps<"span"> & { tone?: Tone; dot?: boolean; pulse?: boolean }) {
  const t = TONE_PILL[tone];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3", t.pill, className)} {...props}>
      {dot ? <span className={cn("size-1.5 rounded-full", t.dot, pulse && "live-dot text-current")} /> : null}
      {children}
    </span>
  );
}

/** Neutral bordered tag for metadata (package manager, direct/transitive, strategy). */
export function Tag({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground", className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-2xs", className)} {...props} />;
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-border px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Mono({ className, ...props }: ComponentProps<"code">) {
  return <code className={cn("rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground", className)} {...props} />;
}

/** The single spinner shape, as in nimu-outreach. */
export function Spinner({ className }: { className?: string }) {
  return <CircleNotch className={cn("size-4 shrink-0 animate-spin", className)} aria-hidden />;
}

export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground", className)} role="status" aria-live="polite">
      <Spinner className="size-5" />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border px-5 py-4 last:border-b-0">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="hidden h-3.5 w-24 sm:block" />
        </div>
      ))}
    </div>
  );
}

/** Canonical empty state (nimu-outreach EmptyState). */
export function Empty({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-56 flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon ? (
        <div className="flex size-12 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground shadow-2xs [&>svg]:size-5">{icon}</div>
      ) : null}
      <p className="mt-4 text-sm font-semibold text-foreground">{title}</p>
      {children ? <div className="mt-1.5 max-w-sm text-sm leading-6 text-pretty text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** The one page-title treatment (nimu-outreach PageHeader). */
export function PageHeader({ eyebrow, title, children, action, className }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="text-eyebrow text-muted-foreground uppercase">{eyebrow}</p> : null}
        <h1 className="text-headline text-balance text-foreground">{title}</h1>
        {children ? <div className="mt-1.5 max-w-2xl text-sm leading-6 text-pretty text-muted-foreground">{children}</div> : null}
      </div>
      {action ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">{action}</div> : null}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Tablist segmented control (nimu-outreach SegmentedControl). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  ariaLabel,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    onValueChange(options[next]!.value);
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn("no-scrollbar inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1 shadow-2xs", className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              selected ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
            )}
          >
            {o.label}
            {o.count !== undefined ? (
              <span className={cn("min-w-5 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums", selected ? "bg-primary-foreground/15 text-primary-foreground" : "bg-background/70 text-muted-foreground")}>
                {o.count.toLocaleString()}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
