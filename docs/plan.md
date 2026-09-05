# Review Agent Implementation Plan

This plan breaks the build into milestones. Each milestone delivers a working, testable slice of UX
and builds on the previous one. The intent is that the agent is always runnable at each milestone
boundary, with tests covering whatever behavior has been added so far.

The abstract per-milestone UX is described as "target behavior" so the milestone is verifiable from
the command line, not just from unit-test pass/fail.

---

## Foundation facts (verified against the GitHub API)

These drive several design choices below; they are recorded here so the implementation does not
re-derive them.

- **Authenticated user**: `gh api graphql -F query='{ viewer { login } }' -> viewer.login`.
- **Fork detection**: The PR's `isCrossRepository: Boolean` field is `true` iff the PR head branch
  lives in a fork. This is the correct signal (an owner comparison is not). Fork PRs are *eligible*
  for review: discovery is scoped to the allowlisted base repos, comments are posted only to the
  base repo's pending-review endpoint, and the test account (`dgp1130-test`) has no repo access, so
  test PRs are necessarily fork PRs.
- **Active reviewer status**: `pullRequest.reviewRequests { nodes { requestedReviewer { ... on User { login } } } }`
  lists users currently requested to review. When the author clicks "re-request review" in the UI,
  the current user remains/returns in this list.
- **Re-review trigger**: There is no timestamp on re-requests. Instead, re-review when the PR is
  `open`, the current user is an active reviewer/assignee, and the current `headRefOid` differs from
  the `lastReviewedCommitSha` we recorded. This covers both the initial review and re-reviews after
  new commits, and prevents re-reviewing an unchanged PR.
- **Draft (pending) review comments**: `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with the
  `event` field **omitted** creates a PENDING review whose inline `comments` array is shown as a
  **draft** in the UI. `comments[]` entries take `path`, `line`, `side`, `start_line` (for ranges),
  and `commit_id` (defaulted to the PR head). We never submit the review, so posts stay drafts.
- **Existing comments read**: `GET /repos/{owner}/{repo}/pulls/{number}/comments` (review comments)
  and `/reviews` to observe existing threads so the LLM can build on prior context.

---

## Project layout

```
review-agent/
  package.json
  tsconfig.json
  vitest.config.ts
  .gitignore                # ignores dist/, state, node_modules
  src/
    cli.ts                  # arg parsing + main dispatch
    config.ts               # resolved options (repo, orgs, skill, state paths)
    github/
      client.ts             # thin gh command runner + GitHub REST/GraphQL calls
      auth.ts               # validate gh installed + authenticated
      prs.ts                # PR discovery + eligibility
      diffs.ts              # fetch PR files + diffs
      comments.ts           # read existing comments, create draft review
    state/
      store.ts              # load/save/prune state.json
      types.ts              # State, PrRecord
    llm/
      provider.ts           # abstract chat interface + OpenCode/Antigravity adapter
      prompt.ts             # build system + user prompt from skill + PR
      tools.ts              # constrained tool definitions for the LLM
      agent.ts              # run LLM loop with tool calls; returns draft comments
    review/
      workflow.ts           # orchestrates a single PR review (shared by poll + --pr)
    polling/
      daemon.ts             # 30s loop, uses workflow per eligible PR
    index.ts                # entry
  dist/                     # tsc output (gitignored) — state.json lives here at runtime
```

State lives at `dist/state.json` so it is automatically gitignored alongside build output.

Tests are colocated with `src/` using the Vitest-standard `.test.ts` suffix (e.g.
`src/github/prs.test.ts` next to `src/github/prs.ts`).

---

## Milestone 0 — Project scaffolding

**Goal**: A `tsc`-buildable Node/TypeScript project with Vitest wired up, and a CLI that validates the
`gh` environment. Nothing reviews yet.

**Steps**

1. `npm init -y`; add `typescript`, `vitest`, `@types/node` as dev deps.
2. `tsconfig.json` targeting modern Node ESM (`module: "nodenext"`, `target: "es2022"`,
   `strict`, `rootDir: "src"`, `outDir: "dist"`, `sourceMap`). No `ts-node` — a real `tsc` build.
3. `package.json` scripts:
   - `build` → `tsc`
    - `start` → `node dist/index.js`
    - `test` → `vitest run`
4. `.gitignore`: `node_modules/`, `dist/`. Because state lives under `dist/`, it is covered.
5. `src/cli.ts`: parse `process.argv`:
   - positional `[skillPath]` (required)
   - `--pr <url>` (optional)
   - `--orgs <comma,list>` (optional, repeatable)
   Run `gh auth status` first; crash with a clear message if `gh` is missing or unauthenticated.
6. `src/github/auth.ts`: resolve the current `gh` user via `viewer.login`.
7. `src/config.ts`: resolve and validate the final option set (repo hard-coded default
   `dgp1130/review-agent`, org allowlist, skill path, state path under `dist/`).
8. Vitest smoke test: CLI rejects a missing skill path; auth module surfaces a missing `gh`.

**Target behavior**

- `npm run build` succeeds.
- `node dist/index.js` (no skill) prints usage and exits non-zero.
- `npm test` passes.

---

## Milestone 1 — PR discovery and eligibility

**Goal**: Correctly discover PRs the agent should consider, using the real fork/reviewer/head-SHA
signals. Builds on Milestone 0's config + auth.

**Steps**

1. `src/github/client.ts`: a minimal `gh` runner that shells out to `gh api` (REST/GraphQL) and
   returns parsed JSON. Centralize base URL/pagination here. (Note: unlike the LLM, the *agent
   harness* may invoke `gh`; the LLM itself only sees constrained tools, enforced in Milestone 4.)
2. `src/github/prs.ts` — `listCandidatePrs({ orgs, repo, username })`:
   - Query open PRs where the current user is a reviewer/assignee, across the hard-coded repo and
     each allowlisted org, using `search` / `repository` queries with `isCrossRepository`,
     `reviewRequests { requestedReviewer.login }`, `assignees`, `headRefOid`, `number`, `state`,
     `headRepository.owner.login`.
   - Filter to: `state=OPEN` and (current user in `reviewRequests` **or** in `assignees`). Fork
     (`isCrossRepository=true`) PRs are included — discovery stays scoped to the allowlisted
     repo/orgs, and comments are only ever posted to the base repo, so fork ownership is irrelevant.
3. `src/state/store.ts` + `types.ts`: define `PrRecord { prNumber, owner, repo, reviewedAt,
   lastReviewedCommitSha, messages[], draftCommentIds[] }` and `State { prs: Record<key, PrRecord> }`.
   Implement `loadState()` (fresh + warn on corrupt/missing), `saveState()`, `pruneClosedPrs()`,
   keyed by `${owner}/${repo}#${number}`.
4. `src/review/workflow.ts` stub that, given a candidate PR, decides *needs-review?* = not already
   reviewed at current `headRefOid`:
   - no `PrRecord` → needs review
   - `lastReviewedCommitSha !== headRefOid` → needs review
   - else → skip.
5. Wire Milestone 1 into `cli.ts` for the `--pr <url>` path: parse owner/repo/number from the URL,
   fetch that one PR, run the eligibility decision, and (for now) just log the decision.

**Tests**

- PR discovery finds fork and non-assigned/closed PRs as expected.
- Eligibility decision for the three cases (new, changed head SHA, unchanged).
- State load/save/prune; corrupt-file recovery.

**Target behavior**

- `node dist/index.js skill.md --pr https://github.com/dgp1130/review-agent/pull/N`
  prints whether the PR is eligible, then exits.

---

## Milestone 2 — Draft comment posting

**Goal**: Post file-level **draft (pending)** review comments to a PR via the API. Builds on
Milestone 1's client and PR targeting.

**Steps**

1. `src/github/comments.ts`:
   - `fetchExistingComments(owner, repo, number)` via `GET .../pulls/{n}/comments` and
     `GET .../pulls/{n}/reviews`.
   - `postDraftReview(owner, repo, number, commitSha, comments[])`: `POST .../pulls/{n}/reviews`
     with **no `event`** (pending) and a `comments[]` payload of `{ path, line, side, start_line?,
     body }`. Record returned comment IDs. Never submit.
2. `src/github/diffs.ts`: `fetchFiles(owner, repo, number)` returning the PR file list and per-file
   patch/diff, so comments can be targeted to real diff lines and the LLM gets diff context.
3. `src/review/workflow.ts`: expand the `--pr` path to post a small fixed set of test comments (e.g.,
   from a fixture) to confirm the draft posting path end-to-end.
4. Safety guards (harden against misuse before any LLM is wired):
   - Reject any attempt to post a **non-draft** review (submit/review event). Only pending allowed.
   - Never touch files outside the target repo; never edit/remove existing comments.
   - Validate that every comment's `path` is a file changed in the PR.

**Tests**

- `postDraftReview` builds the correct pending payload and omits `event`.
- Comment path validation rejects files not in the diff.
- Reply/respond helper (for future use) is stubbed with a guard that it does not create top-level
  reviews.

**Target behavior**

- `--pr <url>` posts draft inline comments visible in the PR's "pending review" as editable drafts,
  with no submitted review event, then exits.

---

## Milestone 3 — Constrained LLM tool surface

**Goal**: Let an LLM *generate* review comments, but only through a fixed, safe tool set. Builds on
Milestone 2's GitHub primitives.

**Steps**

1. `src/llm/provider.ts`: a narrow chat interface (system + messages → assistant text / tool calls),
   with an adapter that can talk to either:
   - an OpenCode local model endpoint, or
   - an Antigravity sidecar endpoint.
   No API-key management; endpoint/model resolved from platform environment/config, selectable by an
   env var (e.g., `REVIEW_AGENT_PROVIDER=opencode|antigravity`).
2. `src/llm/tools.ts`: define tool **definitions** the model may call, mapping to the constrained
   GitHub primitives from Milestone 2:
   - `read_file(path)` → file content at the PR head commit
   - `read_other_file(owner, repo, path)` → file in the repo (not necessarily changed by the PR)
   - `create_comment(path, line, body)` → queues a draft comment for that file/line
   - `respond_to_comment(commentId, body)` → stubbed for future threaded replies
   No shell, no filesystem, no submitting reviews. Owners/repos the tools accept are restricted to
   the hard-coded repo and the allowlisted orgs.
3. `src/llm/prompt.ts`: build the system prompt from the skill file contents, plus a thin,
   **unopinionated** primer ("produce file-level comments via the tools; do not create a top-level
   review; follow the skill guidance"). The user prompt is built from PR metadata + diffs +
   existing comments (from Milestone 2).
4. `src/llm/agent.ts`: a loop that calls the provider, executes requested tool calls against the
   constrained surface, collects `create_comment` results, and terminates when the model signals the
   review is complete.

**Tests**

- A fake provider scripted to call each tool verifies argument passing and result shaping.
- Tool surface rejects out-of-allowlist repos/owners and any non-whitelisted tool name.
- Prompt builder renders skill content verbatim and does not inject opinions.

**Target behavior**

- `--pr <url>` runs the LLM loop, the model produces final file-level draft comments, and the agent
  exits with a JSON summary of the comments it *would* post (not yet posted — posting lands in
  Milestone 4).

---

## Milestone 4 — End-to-end single-PR review

**Goal**: The `--pr <url>` mode fully reviews a real PR: read context, run the LLM agent, post draft
comments, and record state. Builds on Milestones 0–3.

**Steps**

1. `src/review/workflow.ts` — full orchestration for one PR:
   1. Fetch PR metadata, files/diffs, and existing comments.
   2. Determine eligibility (Milestone 1).
   3. Build the prompt (Milestone 3) including existing review context.
   4. Run the LLM agent (Milestone 3) to get tool calls.
   5. `postDraftReview(...)` with the collected comments and the current head SHA (Milestone 2).
   6. Record `lastReviewedCommitSha = headRefOid`, `reviewedAt = now`, append the conversation to
      `messages[]`, save `draftCommentIds`, and save state (Milestone 1).
2. Remove the Milestone 2 fixture injection; the real LLM output drives comments.
3. Wire the `--pr` path in `cli.ts` to the workflow.

**Tests**

- Integration test with mocked GitHub + a scripted LLM: asserts the correct pending-review payload
  is posted at the head SHA and state is persisted with the head SHA and conversation.
- Duplicate-prevention: if the same head SHA is already reviewed, `--pr` skips posting.
- No top-level review body is ever created; only pending reviews with inline `comments`.
- Never edits/removes existing comments.

**Target behavior**

- `node dist/index.js skill.md --pr <url>` posts genuine draft file-level comments to the PR (visible
  as a pending editable review), records state, and exits synchronously. Re-running on the same SHA
  is a no-op.

---

## Milestone 5 — Conversation continuity across re-reviews

**Goal**: A single LLM conversation per PR persists across re-review rounds so later reviews build on
prior ones. Builds on Milestone 4's state + workflow.

**Steps**

1. Extend the workflow's prompt assembly: if `state.messages[]` already has history for the PR,
   seed the LLM conversation with it (system + prior messages) instead of starting fresh.
2. On each review, append a user message summarizing the delta: e.g., "Re-review: the PR head
   changed from `<lastReviewedCommitSha>` to `<headRefOid>`. These files changed since your last
   review: `<diff summary>`. Produce updated file-level comments."
3. Persist the updated `messages[]` after each round so the next re-request continues the same
   conversation (bounded truncation/summarization of very old turns to control token size).
4. Re-review trigger integration: in both `--pr` and (later) polling, eligibility already keys off
   `lastReviewedCommitSha !== headRefOid` from Milestone 1 — re-requesting a review via the GitHub UI
   when new commits are present thus continues the same conversation.

**Tests**

- A two-round mock: round 1 posts comments and stores messages; round 2 (new head SHA) seeds with the
  stored messages and posts deltas.
- Conversation summarization trims oversized histories without losing the last round.

**Target behavior**

- After a re-request with new commits, `--pr <url>` produces follow-up comments aware of what was
  already said, instead of a fresh review.

---

## Milestone 6 — Polling daemon

**Goal**: The long-lived UX. Builds on everything above; this is the "`review-agent skill.md`" flow.

**Steps**

1. `src/polling/daemon.ts`: a `setInterval` (or `while(true)+sleep`) loop at a **hard-coded 30s**
   cadence:
   - In each tick: `listCandidatePrs` (Milestone 1) → for each, run the full workflow
     (Milestone 4/5) if eligible.
   - `pruneClosedPrs` from state each tick (Milestone 1).
   - Log each tick: count discovered, skipped, reviewed, errors.
2. `cli.ts`: when `--pr` is absent, enter the daemon instead of exiting.
3. Graceful shutdown on `SIGINT`/`SIGTERM`: flush state, stop loop.

**Tests**

- Daemon tick runs the workflow for eligible PRs and skips unchanged ones (mocked GitHub + LLM, with
  a short interval override for tests only).
- `pruneClosedPrs` removes closed/merged records (by PR state, not by time).
- Shutdown handler flushes state.

**Target behavior**

- `review-agent /path/to/SKILL.md` runs continuously: every ~30s it discovers newly eligible PRs,
  reviews them as drafts, and skips PRs already reviewed at their head SHA. Logs progress to stdout
  without needing `--pr`.

---

## Milestone 7 — Hardening & polish

**Goal**: Make the daemon robust and reviewable. Builds on Milestone 6.

**Steps**

1. Error handling/retries:
   - GitHub API errors and rate limits: log, back off (e.g., exponential with cap), continue to next
     PR / next tick; never crash the daemon.
   - LLM failures: log, retry transient failures with backoff, then move on without posting partial
     reviews.
2. Idempotency/duplicate safety:
   - Guard against creating duplicate draft comments by re-checking the head SHA immediately before
     posting.
   - Do not repost comments whose IDs are already in `draftCommentIds`.
3. Logging: structured, `stdout`, includes PR discovery counts, per-PR actions, and comment posting
   results. No secrets/tokens logged.
4. Startup validation (from Milestone 0) runs before the daemon: `gh` present + authenticated; skill
   file exists and is readable; state directory exists/creatable.
5. Concurrency guard: prevent two daemon instances against the same state file (lockfile / O_EXCL).

**Tests**

- Retry/backoff behavior for transient GitHub and LLM failures.
- Duplicate-posting guard across overlapping daemon ticks.
- Startup validation raises clear errors (missing gh, unauthenticated, missing skill, unwritable
  state dir).
- Lockfile prevents concurrent instances.

**Target behavior**

- The daemon sustains errors without dying, never double-posts, logs cleanly, and refuses to start
  with a broken environment or a second copy running.

---

## Summary dependency chain

```
M0 scaffolding → M1 discovery/eligibility → M2 draft posting → M3 LLM tools
                                                                       │
M5 conversation ←── M4 end-to-end single-PR ──────────────────────────┘
                        │
M6 polling daemon ←─────┘
                        │
M7 hardening ←──────────┘
```

Acceptance criteria across the whole plan:

- Only ever posts **draft/pending** reviews — never a submitted review, never a top-level review body.
- Only ever operates on `dgp1130/review-agent` and the explicitly allowlisted `--orgs`.
- Never edits or removes existing comments.
- No permission prompts; capabilities come only from the constrained tools.
- Fork (cross-repository) PRs are reviewed like any other PR discovered in the allowlisted scope; `gh` auth validated at startup.
- Re-reviews continue the same per-PR conversation.
- Fully testable (`vitest`) at every milestone boundary.
