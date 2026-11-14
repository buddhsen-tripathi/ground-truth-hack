/** Bindings from wrangler.jsonc plus the secrets from .dev.vars / `wrangler secret put`. */
export type AppEnv = Env & {
  YOU_API_KEY?: string;
  CLONVO_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  GITHUB_TOKEN?: string;
  /** OpenCrawl agent access token (`opencrawl token create`): agent history search and the board. */
  OPENCRAWL_TOKEN?: string;
  OPENCRAWL_API_URL?: string;
  /** Claude Code token (`claude setup-token`): runs Claude Code as the repair agent inside the sandbox. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CLONVO_BASE_URL: string;
  DAYTONA_API_URL: string;
  FIX_MODEL: string;
  EXTRACT_MODEL: string;
};

export class MissingKeyError extends Error {
  constructor(public key: string) {
    super(`${key} is not set. Add it to .dev.vars (local) or \`wrangler secret put ${key}\` (deployed).`);
  }
}

export function requireKey(env: AppEnv, key: "YOU_API_KEY" | "CLONVO_API_KEY" | "DAYTONA_API_KEY" | "GITHUB_TOKEN"): string {
  const value = env[key];
  if (!value) throw new MissingKeyError(key);
  return value;
}

export const now = () => new Date().toISOString();
export const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
