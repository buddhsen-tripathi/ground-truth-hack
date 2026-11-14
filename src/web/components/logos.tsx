import {
  siAngular,
  siAstro,
  siBun,
  siClaude,
  siCloudflare,
  siExpo,
  siGithub,
  siJest,
  siNextdotjs,
  siNpm,
  siNuxt,
  siPnpm,
  siPytest,
  siPython,
  siReact,
  siRemix,
  siSvelte,
  siTypescript,
  siUv,
  siVite,
  siVitest,
  siYarn,
  type SimpleIcon,
} from "simple-icons";
import { cn } from "@/lib/utils";

/* Logos for the tools and services a run uses. Brand marks come from simple-icons; services without one get a monogram. */

export type LogoId =
  | "claude"
  | "opencrawl"
  | "daytona"
  | "you"
  | "clonvo"
  | "osv"
  | "github"
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "uv"
  | "python"
  | "typescript"
  | "expo"
  | "pytest"
  | "jest"
  | "vitest"
  | "vite"
  | "next"
  | "astro"
  | "remix"
  | "nuxt"
  | "svelte"
  | "angular"
  | "react"
  | "cloudflare";

const ICONS: Partial<Record<LogoId, SimpleIcon>> = {
  claude: siClaude,
  github: siGithub,
  npm: siNpm,
  pnpm: siPnpm,
  yarn: siYarn,
  bun: siBun,
  uv: siUv,
  python: siPython,
  typescript: siTypescript,
  expo: siExpo,
  pytest: siPytest,
  jest: siJest,
  vitest: siVitest,
  vite: siVite,
  next: siNextdotjs,
  astro: siAstro,
  remix: siRemix,
  nuxt: siNuxt,
  svelte: siSvelte,
  angular: siAngular,
  react: siReact,
  cloudflare: siCloudflare,
};

/** Monograms for services simple-icons doesn't carry: [text, background, foreground]. */
const MONOGRAMS: Partial<Record<LogoId, [string, string, string]>> = {
  opencrawl: ["oc", "#0f766e", "#ffffff"],
  daytona: ["D", "#111111", "#ffffff"],
  you: ["you", "#6d28d9", "#ffffff"],
  clonvo: ["C", "#2563eb", "#ffffff"],
  osv: ["OSV", "#334155", "#ffffff"],
};

export const LOGO_NAMES: Record<LogoId, string> = {
  claude: "Claude Code",
  opencrawl: "OpenCrawl",
  daytona: "Daytona",
  you: "You.com",
  clonvo: "Clonvo",
  osv: "OSV.dev",
  github: "GitHub",
  npm: "npm",
  pnpm: "pnpm",
  yarn: "Yarn",
  bun: "Bun",
  uv: "uv",
  python: "pip",
  typescript: "TypeScript",
  expo: "Expo",
  pytest: "pytest",
  jest: "Jest",
  vitest: "Vitest",
  vite: "Vite",
  next: "Next.js",
  astro: "Astro",
  remix: "Remix",
  nuxt: "Nuxt",
  svelte: "SvelteKit",
  angular: "Angular",
  react: "React",
  cloudflare: "Wrangler",
};

/** Near-black brand colors follow the theme's foreground instead, so they stay visible in dark mode. */
function dark(hex: string) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60;
}

export function Logo({ id, size = 16, className, title }: { id: LogoId; size?: number; className?: string; title?: string }) {
  const icon = ICONS[id];
  const label = title ?? LOGO_NAMES[id];
  if (icon) {
    return (
      <svg role="img" aria-label={label} viewBox="0 0 24 24" width={size} height={size} className={cn("shrink-0", className)} fill={dark(icon.hex) ? "currentColor" : `#${icon.hex}`}>
        <title>{label}</title>
        <path d={icon.path} />
      </svg>
    );
  }
  const [text, bg, fg] = MONOGRAMS[id] ?? ["?", "#64748b", "#fff"];
  return (
    <svg role="img" aria-label={label} viewBox="0 0 24 24" width={size} height={size} className={cn("shrink-0", className)}>
      <title>{label}</title>
      <rect width="24" height="24" rx="6" fill={bg} />
      <text x="12" y="12" dy="0.36em" textAnchor="middle" fill={fg} fontSize={text.length > 2 ? 8.5 : text.length > 1 ? 11 : 14} fontWeight={700} fontFamily="ui-sans-serif, system-ui">
        {text}
      </text>
    </svg>
  );
}

/** A logo on a small tile, for rows of tools. */
export function LogoTile({ id, size = 14, className }: { id: LogoId; size?: number; className?: string }) {
  return (
    <span className={cn("inline-grid shrink-0 place-items-center rounded-md border border-border bg-card text-foreground shadow-xs", className)} style={{ width: size + 10, height: size + 10 }} title={LOGO_NAMES[id]}>
      <Logo id={id} size={size} />
    </span>
  );
}

export const managerLogo = (manager: string): LogoId =>
  manager === "pnpm" ? "pnpm" : manager === "yarn" ? "yarn" : manager === "bun" ? "bun" : manager === "uv" ? "uv" : manager === "pip" ? "python" : "npm";

/** Logo for a tool event id ("opencrawl.search", "claude.Bash", "expo.doctor", "you.search"). */
export function toolLogo(tool: string): LogoId {
  const head = tool.split(".")[0];
  if (head === "claude" || head === "opencrawl" || head === "expo" || head === "you" || head === "clonvo") return head;
  return "claude";
}

/** "claude.Bash" → "Bash", "opencrawl.search" → "search". */
export const toolAction = (tool: string) => tool.split(".").slice(1).join(".") || tool;

/** Tools a check command uses, for the Checks step. */
export function checkLogos(commands: string[]): LogoId[] {
  const out = new Set<LogoId>();
  for (const c of commands) {
    if (/\btsc\b|type-?check/.test(c)) out.add("typescript");
    if (/expo export/.test(c)) out.add("expo");
    if (/pytest/.test(c)) out.add("pytest");
    if (/\bvitest\b/.test(c)) out.add("vitest");
    if (/\bjest\b/.test(c)) out.add("jest");
    if (/compileall/.test(c)) out.add("python");
    const m = /(?:^|&& |\()\s*(npm|pnpm|yarn|bun) (?:run )?(?:test|build)\b/.exec(c);
    if (m) out.add(managerLogo(m[1]!));
  }
  return [...out];
}

export function frameworkLogo(framework?: string): LogoId | null {
  if (!framework) return null;
  const f = framework.toLowerCase();
  if (f.includes("expo")) return "expo";
  if (f.includes("next")) return "next";
  if (f.includes("vite") || f.includes("vinext")) return "vite";
  if (f.includes("astro")) return "astro";
  if (f.includes("remix") || f.includes("react router")) return "remix";
  if (f.includes("nuxt")) return "nuxt";
  if (f.includes("svelte")) return "svelte";
  if (f.includes("angular")) return "angular";
  if (f.includes("wrangler")) return "cloudflare";
  if (f.includes("react")) return "react";
  return null;
}
