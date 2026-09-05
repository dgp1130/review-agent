# Review Agent

An AI agent for reviewing GitHub PRs based on a skill.

## Local development

Requires Node.js (pinned in `.nvmrc`). Using `nvm`, install the pinned version with:

```sh
nvm install
```

Then install dependencies and run the usual scripts:

```sh
npm install
npm run build   # tsc -> dist/
npm test        # vitest
npm run lint    # eslint (all findings are errors)
npm run check   # required gate: lint + typecheck + tests
npm start -- <skill.md> [--pr <url>] [--orgs org1,org2,...]
```

Requires the GitHub CLI (`gh`) installed and authenticated.
