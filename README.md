# Firebreak

From supply-chain disclosure to a tested hotfix PR in minutes.

Firebreak watches your repos' lockfiles. When a malicious release or a vulnerability hits a version you actually resolve, it shows
where it sits (direct or transitive, which lockfile), which CI runs installed it since disclosure and which secrets to rotate. It
then fixes it in an isolated Daytona sandbox: patch, install with lifecycle scripts disabled, prove the lockfile is clean, run your
checks, let an agent repair breaking changes, repeat. A PR is opened only when you click.

## How it works

| Stage | What runs | Tools |
| --- | --- | --- |
| Inventory | Reads `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (classic + berry), `bun.lock` and workflow `uses:` refs from the default branch | GitHub API |
| Live wire | Every 10 min (plus **Check now**): every resolved version goes to OSV (including `MAL-` malware entries); fresh security news is read and a model pulls out named packages and versions as early signals | OSV, You.com, Clonvo (Haiku 5.5) |
| Exposure | Matches incidents to resolved versions; for malicious versions, lists CI runs since disclosure and workflow secrets to rotate | GitHub API |
| Fix plan | Picks a target that clears **every** known advisory for the package: upgrade, pin back below the first bad release, or an override for transitive deps | npm registry |
| Fix loop | One Durable Object per run, one phase per alarm, logs streamed over WebSocket: sandbox, clone, patch, install (`--ignore-scripts`), verify lockfile, checks, agent repair (up to 3 rounds) | Daytona, Clonvo (Sonnet 5.5), You.com for migration notes |
| PR | On click: commits the changed files through the GitHub API, with a receipt (sources, lockfile check, attempts, agent notes) as the PR body | GitHub API |

Safety rails: the sandbox gets no secrets (the GitHub token is used for the clone and then removed from the remote); installs never
run lifecycle scripts; tests never run if the lockfile still resolves an affected version; no PR without a passing run and a click.

## Stack

One Cloudflare Worker (Hono) serving a Vite + React SPA (TanStack Router + Query, Tailwind v4), D1 for records, a `FixRun` Durable
Object per hotfix. Same shape as clonvo-gateway; visual language from Nimu.

## Run locally

```sh
bun install
cp .dev.vars.example .dev.vars        # fill in the four keys
bun run db:migrate:local
bun run dev                           # http://localhost:5173
```

Keys (`.dev.vars`): `YOU_API_KEY`, `CLONVO_API_KEY`, `DAYTONA_API_KEY`, `GITHUB_TOKEN` (fine-grained PAT on the demo repos only:
Contents read/write, Pull requests read/write, Actions read, Metadata read). The UI shows which keys are present; OSV needs none.

Checks: `bun run test` (parsers and version selection) and `bun run typecheck`.

## Deploy

```sh
bunx wrangler d1 create firebreak     # paste the id into wrangler.jsonc
bun run db:migrate:remote
bunx wrangler secret put YOU_API_KEY  # and CLONVO_API_KEY, DAYTONA_API_KEY, GITHUB_TOKEN
bun run deploy
```

The deployed app has no access control: anyone with the URL can start fix runs on your credits and open PRs with your token.
