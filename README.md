# Review Agent

An AI agent for reviewing GitHub PRs based on a skill.

## Local development

```sh
npm install
npm run build   # tsc -> dist/
npm test        # vitest
npm run lint    # eslint (all findings are errors)
npm run check   # required gate: lint + typecheck + tests
npm start -- <skill.md> [--pr <url>] [--orgs org1,org2,...]
```

Requires the GitHub CLI (`gh`) installed and authenticated.
