# Review Agent Design Document

## Overview

The Review Agent is a long-lived, lightweight CLI process that polls GitHub for active pull requests assigned to the current user and produces draft, file-level review comments using an LLM. The agent is constrained to a minimal tool surface (read files, post draft comments, respond to existing comments) and must never modify the repository beyond those draft comments. A single LLM conversation per PR is reused across re-review cycles to preserve context.

This document captures the proposed architecture, key design decisions, and implementation plan.

## Goals and Constraints

- Runtime environment: Node.js (TypeScript or JavaScript). No self-contained binary required.
- Polling cadence: Hard-coded 30-second polling cadence.
- LLM integration: Should work in a local OpenCode model and in an Antigravity sidecar; no manual API key management required.
- Re-review detection: Trigger when a review is re-requested in the GitHub UI or when new commits appear after the last review.
- State persistence: Local file-system state to track reviewed PRs and conversation context across restarts.
- Skill file: Provided as a required CLI argument; drives the system prompt for the LLM.
- Comments: Only draft, file-level comments are posted; no top-level review body; do not edit or remove existing draft comments.
- Security: The review-agent process runs as a normal user process; the LLM agent is isolated to the constrained tools and does not have general system access; no secrets logging.
- Testing: Unit tests for core modules; a single-PR mode for synchronous testing.
- Repository hard-coding: The agent is hard-coded to review PRs against dgp1130/review-agent and may monitor additional orgs via --orgs; it must never mutate any repository beyond drafting comments.

## Architecture

### High-level components

- CLI entry point: Accepts a skill file path, optional --pr <url> for single-PR mode, and an --orgs flag to allowlist GitHub orgs to monitor. Starts either a single review or a polling loop.
- Polling loop: Every 30s, queries GitHub for candidate PRs assigned to the authenticated user in the target repo.
- PR discovery and filtering:
  - Determine the current user via the gh CLI; fetch open PRs assigned to/review-requested of that user across allowed orgs and the dgp1130/review-agent repo.
  - Include fork (cross-repository) PRs: comments are only ever posted to the base repo's PR review endpoint and discovery/the `--pr` path are gated by the repo allowlist, so a fork PR's ownership never matters. Updated during test-account setup: `dgp1130-test` has no repo access, so test PRs can only be created from a fork.
  - Exclude PRs that are already reviewed (based on state).
  - Consider PRs needing review only if they are not already reviewed at the current head SHA (a re-review request or new commits since the last review).
- Review workflow for a PR:
  - Fetch PR metadata, diffs, and existing comments via the constrained tools.
  - Build or continue an LLM conversation with:
    - System prompt derived from the skill file and a base code-review primer.
    - User prompt containing PR title/body, changed files, diffs, and existing review comments.
  - Use the LLM to generate file-level comments (no top-level review body).
  - Post draft comments on the appropriate files/lines via the constrained tooling.
  - Persist the conversation and update state to reflect that the PR has been reviewed.
- State persistence:
  - A JSON state file that records per-PR:
    - prNumber
    - reviewedAt (ISO timestamp)
    - lastReviewedCommitSha (string)
    - conversation history (messages array)
    - draftCommentIds (list of comment IDs to avoid duplicates)
  - Staleness handling: Remove PRs which are closed or merged (do not expire by time).
- LLM integration:
  - Use the OpenCode local model or an Antigravity sidecar endpoint; no manual API key management required.
  - Constrained tool surface for the LLM:
    - read_file(path) -> content
    - create_comment(path, body, line, commitId) -> commentId
    - respond_to_comment(commentId, body) -> (optional)
  - Conversation reuse: Persist conversation per PR; on re-review, append a new user message summarizing changes since the last review and continue.
- Tooling and security:
  - The agent must not have shell access or broad filesystem write access beyond the state file.
  - All GitHub interactions are via constrained tools that only permit reading files, creating draft comments, and replying to comments on the target repo.
- Testing and validation:
  - Unit tests for GitHub wrappers, state management, prompt assembly, and tool adapters.
  - Integration tests with mocked GitHub API and LLM endpoints.
  - Single-PR mode for synchronous testing.

## Detailed Design

### 1) CLI and entry point

- Inputs:
  - Skill file path (required)
  - --pr <url> (optional) to review a single PR and exit
  - --orgs <org1,org2,...> (optional) to allowlist GitHub orgs to monitor
- Behavior:
  - On startup, run `gh auth status` and crash if the user is not authenticated or gh is not installed
  - If --pr is provided, load the skill file, fetch the specified PR, run the review workflow, post draft comments, and exit
  - Otherwise, start a polling loop that repeats the review workflow for eligible PRs across allowed orgs and dgp1130/review-agent

### 2) GitHub integration (constrained tools)

- Use GitHub GraphQL (or REST) to:
  - Fetch open PRs assigned to the current user across allowed orgs and the dgp1130/review-agent repo
  - Fetch PR metadata, diffs, and existing comments
  - Post draft Pull Request review comments (file-level)
- Constrained tools exposed to LLM:
  - read_file(path): Retrieve file content from the repo at the PR’s head commit
  - create_comment(path, body, line, commitId): Post a draft comment on a specific file/line
  - respond_to_comment(commentId, body): Reply to an existing comment (optional, for future use)
- Security:
  - No shell access; no writes to the repo beyond drafting comments
  - Assume and validate that the gh CLI is already authenticated on startup; do not manage tokens

### 3) Polling and re-review detection

- Polling cadence: Hard-coded 30-second polling interval
- PR eligibility criteria:
- PR is open
- PR is assigned to the current user (via reviewer request or assignment)
- PR belongs to the default repo or an allowlisted org (base repo of fork PRs included)
- PR has not been reviewed yet (state reviewedAt is absent or head SHA differs from lastReviewedCommitSha)
- Re-review detection:
  - Use review request metadata and compare lastReviewedCommitSha to the current head SHA; re-trigger review when a review is requested or when new commits appear after a review request
- State:
  - Maintain a per-PR record with reviewedAt, lastReviewedCommitSha, conversation history, and draft comment IDs

### 4) LLM conversation design and reuse

- System prompt:
  - Start with the skill content (from the CLI-provided file)
  - Add a minimal code-review primer that instructs the model to be unopinionated, direct, and to produce file-level comments only
- User prompt for a PR:
  - PR metadata (title, body, author, base branch, head branch)
  - Changed file paths and diffs (or patches) for the PR
  - Existing review comments (to inform new comments)
- Conversation reuse:
  - Persist conversation messages per PR (role, content)
  - On re-review, append a new user message summarizing what changed since the last review and ask for updated file-level comments
  - Keep conversation size manageable by summarizing older turns if necessary (optional optimization)

### 5) Comment ergonomics

- Only file-level draft comments are posted; no top-level review body
- Do not edit or remove existing draft comments
- The review-agent tool is unopinionated about LLM-generated comment content and format; the user-provided skill guides specifics

### 6) State management and cleanup

- State file location: Repo-local within a .gitignored directory (e.g., dist/)
- Staleness policy:
  - Remove PRs which are closed or merged (do not expire by time)
- Robustness:
  - If state file is missing or corrupt, initialize fresh state and log a warning

### 7) Error handling and logging

- Log key events to stdout:
  - PR discovery counts, skipped PRs, review attempts, comment posting results, errors
- Errors:
  - GitHub API errors: log and continue to next PR; do not crash the loop
  - LLM errors: log and continue; optionally retry with backoff for transient failures
- Retries:
  - Use a simple retry policy for transient GitHub/LLM errors (e.g., 3 retries with exponential backoff)

### 8) Testing strategy

- Unit tests:
  - GitHub client wrappers (GraphQL/REST)
  - State management (load/save/prune)
  - Prompt assembly and conversation management
  - Tool adapters (read_file, create_comment)
- Integration tests:
  - Mocked GitHub API for PR discovery, fetching diffs, and posting comments
  - Mocked LLM endpoint to validate prompt structure and conversation reuse
- Single-PR mode:
  - Provide a --pr <url> mode that reviews a single PR and exits, synchronously

## Decisions finalized

- Runtime and packaging
  - Node.js with TypeScript; use tsc to build (no ts-node)
- LLM endpoint specifics
  - Must work with OpenCode local models and Antigravity sidecars; discovery via runtime environment/config specific to those platforms
- Skill file handling
  - Single required CLI argument pointing to one skill file; content used as the system prompt basis
- Re-review detection details
  - Use PR review request metadata and compare last reviewed commit SHA to the current head SHA; re-trigger review when requested or when new commits appear after a review request
- State file location
  - Repo-local within a .gitignored directory (e.g., dist/)
- Comment ergonomics (final)
  - No top-level review body is ever posted; only file-level draft comments are allowed; review-agent is unopinionated about content/format beyond the user skill
- Single-PR mode behavior
  - Actually post draft comments (no dry-run mode)
- Testing framework
  - Vitest
