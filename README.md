# Review Agent

An AI agent for reviewing GitHub PRs based on a skill.

## Local development

Requires Node.js (pinned in `.nvmrc`) and pnpm. Using `nvm`, install the pinned Node version with:

```sh
nvm install
```

pnpm is pinned via `packageManager` in `package.json`; enable it with:

```sh
npm install -g pnpm
# OR
corepack enable
```

Then install dependencies and run the usual scripts:

```sh
pnpm install --frozen-lockfile
pnpm run build   # tsc -> dist/
pnpm test        # vitest
pnpm run lint    # eslint (all findings are errors)
pnpm run check   # required gate: lint + typecheck + tests
pnpm start -- <skill.md> [--pr <url>] [--orgs org1,org2,...]
```

Requires the GitHub CLI (`gh`) installed and authenticated.
