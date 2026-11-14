import { ArrowsClockwise, FolderSimple, Lightning, List, Moon, ShieldWarning, SidebarSimple, SquaresFour, Sun, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { Logo } from "./bits";
import { Logo as ToolLogo, type LogoId } from "./logos";
import { Button, Spinner } from "./ui";

/* App shell modelled on nimu-outreach's components/dashboard/app-shell.tsx:
   collapsible 240px sidebar, h-14 brand row, flat nav, footer utilities, slide-over drawer on mobile. */

const NAV = [
  { to: "/", label: "Overview", icon: SquaresFour },
  { to: "/incidents", label: "Incidents", icon: ShieldWarning },
  { to: "/repos", label: "Repos", icon: FolderSimple },
  { to: "/runs", label: "Fix runs", icon: Lightning },
] as const;

/** Theme lives on <html class="dark">; every toggle instance (sidebar, drawer) reads the same source. */
function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");

function useTheme() {
  const dark = useSyncExternalStore(subscribeTheme, isDark, () => false);
  const toggle = () => {
    const next = !isDark();
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("firebreak-theme", next ? "dark" : "light");
    } catch {
      // storage can be unavailable; the theme still applies for this visit
    }
  };
  return [dark, toggle] as const;
}

function ThemeToggle({ className }: { className?: string }) {
  const [dark, toggle] = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
      className={cn(
        "flex size-8 items-center justify-center rounded-full text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        className,
      )}
    >
      {dark ? <Sun size={16} weight="fill" /> : <Moon size={16} weight="fill" />}
    </button>
  );
}

export function useCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.checkNow,
    onSuccess: (r) => {
      qc.invalidateQueries();
      const parts = [`${r.osvChecked} versions checked on OSV`];
      if (r.newsChecked) parts.push(`${r.newsChecked} new articles read`);
      if (r.newIncidents) parts.push(`${r.newIncidents} new incident${r.newIncidents === 1 ? "" : "s"}`);
      if (r.errors.length) toast.warning(r.errors.join(" · "));
      else toast.success(parts.join(" · "));
    },
    onError: (e) => toast.error((e as Error).message),
  });
}

function WatcherPanel({ collapsed }: { collapsed: boolean }) {
  const { data } = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });
  const check = useCheckNow();
  const integrations = data?.watch.integrations;
  const items: [string, LogoId, boolean | undefined][] = [
    ["OSV", "osv", true],
    ["Daytona", "daytona", integrations?.daytona],
    ["GitHub", "github", integrations?.github],
    ["Codex", "codex", integrations?.codex],
    ["OpenCrawl", "opencrawl", integrations?.opencrawl],
    ["Clonvo", "clonvo", integrations?.clonvo],
    ["You.com", "you", integrations?.you],
  ];
  if (collapsed)
    return (
      <button
        type="button"
        onClick={() => check.mutate()}
        disabled={check.isPending}
        title={`Watching every 10 min · last check ${timeAgo(data?.watch.lastRun?.at)} · Check now`}
        aria-label="Check now"
        className="mx-auto flex size-9 items-center justify-center rounded-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground disabled:opacity-60"
      >
        {check.isPending ? <Spinner /> : <ArrowsClockwise className="size-4" />}
      </button>
    );
  return (
    <div className="space-y-2.5 px-1">
      <div className="flex items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center gap-2 text-sm text-sidebar-foreground">
          <span className="live-dot size-2 shrink-0 rounded-full bg-success text-success" />
          <span className="truncate">Watching every 10 min</span>
        </div>
      </div>
      <p className="px-2 text-xs text-sidebar-foreground/60">Last check {timeAgo(data?.watch.lastRun?.at)}</p>
      <Button variant="outline" size="sm" className="w-full" onClick={() => check.mutate()} disabled={check.isPending}>
        {check.isPending ? <Spinner /> : <ArrowsClockwise />} Check now
      </Button>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 px-2 pt-1">
        {items.map(([name, logo, on]) => (
          <span key={name} className={cn("flex min-w-0 items-center gap-1.5 text-[11px] text-sidebar-foreground/70", !on && "opacity-55")} title={on ? `${name} connected` : `${name} not configured`}>
            <span className="relative grid size-[18px] shrink-0 place-items-center rounded-[5px] border border-sidebar-border bg-sidebar text-sidebar-foreground">
              <ToolLogo id={logo} size={11} />
              <span className={cn("absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-sidebar", on ? "bg-success" : "bg-danger")} />
            </span>
            <span className="truncate">{name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SidebarContent({ collapsed, onCollapse, onClose }: { collapsed: boolean; onCollapse?: () => void; onClose?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
        {!collapsed ? (
          <Link to="/" onClick={onClose} className="flex min-w-0 items-center gap-2">
            <Logo className="size-6 shrink-0" />
            <span className="truncate text-lg font-bold tracking-tight text-sidebar-foreground">Firebreak</span>
          </Link>
        ) : null}
        <div className={cn("flex items-center gap-0.5", collapsed && "mx-auto")}>
          {!collapsed ? <ThemeToggle /> : null}
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              className="hidden rounded-sm p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:flex"
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <SidebarSimple className="size-4" aria-hidden />
            </button>
          ) : null}
          {onClose ? (
            <button type="button" onClick={onClose} className="rounded-sm p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" aria-label="Close navigation">
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? path === "/" : path.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              onClick={onClose}
              aria-current={active ? "page" : undefined}
              title={collapsed ? label : undefined}
              className={cn(
                "mb-1 flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-sm transition-colors",
                collapsed && "justify-center px-0",
                active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" weight={active ? "fill" : "regular"} aria-hidden />
              {!collapsed ? <span className="truncate">{label}</span> : null}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-sidebar-border p-3">
        <WatcherPanel collapsed={collapsed} />
        {collapsed ? <ThemeToggle className="mx-auto" /> : null}
      </div>
      {!collapsed ? (
        <div className="border-t border-sidebar-border px-5 py-3 text-xs text-sidebar-foreground/50">Supply-chain hotfix agent</div>
      ) : null}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-dvh bg-sidebar lg:flex">
      {/* Mobile top bar */}
      <div className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background px-4 lg:hidden">
        <button type="button" onClick={() => setOpen(true)} className="rounded-sm p-2 text-foreground transition-colors hover:bg-muted" aria-label="Open navigation">
          <List className="size-5" aria-hidden />
        </button>
        <Link to="/" className="flex items-center gap-2">
          <Logo className="size-[22px]" />
          <span className="text-base font-bold tracking-tight text-foreground">Firebreak</span>
        </Link>
      </div>

      {/* Mobile overlay + slide-over */}
      {open ? <button type="button" className="fixed inset-0 z-50 bg-black/60 lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation" /> : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        aria-hidden={!open}
        inert={!open}
      >
        <SidebarContent collapsed={false} onClose={() => setOpen(false)} />
      </aside>

      {/* Desktop sidebar */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 64 : 240 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="sticky top-0 hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar lg:flex"
      >
        <SidebarContent collapsed={collapsed} onCollapse={() => setCollapsed((c) => !c)} />
      </motion.aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 md:p-8">{children}</div>
      </main>
    </div>
  );
}
