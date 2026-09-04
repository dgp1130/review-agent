import { ReviewCommentView } from "../github/comments.js";
import { PrFile } from "../github/diffs.js";

export interface PromptPrInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  body: string | null;
}

export interface UserPromptInput {
  pr: PromptPrInfo;
  files: PrFile[];
  existingComments: ReviewCommentView[];
}

/**
 * Builds the system prompt from the skill file contents plus a thin, deliberate
 * primer. The skill content is included verbatim; the primer only explains the
 * mechanism (tools, draft-only, no top-level review) and intentionally does not
 * inject opinions about what a good review should contain.
 */
export function buildSystemPrompt(skillContent: string): string {
  return `You are reviewing a GitHub pull request using constrained tools.

Your findings must be delivered as draft comments via the \`create_comment\` tool.
A text-only reply posts nothing to GitHub; it is treated only as your finishing summary.

## Your review instructions

${skillContent.trimEnd()}

## How to use the tools

- Work autonomously: never ask the user for input or clarification.
- Use \`read_file\` to read a file in the PR at its head commit, and \`read_other_file\` to read context from an allowlisted repo when needed.
- Use \`create_comment\` to produce a draft (pending) review comment on a specific added line of a changed file. Comments are queued and posted as a single pending review when you finish; they are never submitted.
- If a tool returns an error, fix the argument (e.g. pick an added line, use a non-empty body) and call it again — do not stop because of a tool error.
- Produce only file-level comments targeted at specific lines. Do not attempt to create a top-level review body.
- You cannot modify or delete comments. Do not try to edit existing comments.
- When your review is complete, stop calling tools and give a brief summary of your findings.`;
}

/**
 * Builds the user prompt describing the PR, its diff, and any prior review
 * comments, so the model can decide where to comment and avoid repeating
 * existing feedback.
 */
export function buildUserPrompt(input: UserPromptInput): string {
  const { pr, files, existingComments } = input;

  const lines: string[] = [];
  lines.push(`PR #${pr.number}: ${pr.title}`);
  lines.push(`by ${pr.author} in ${pr.owner}/${pr.repo} (head ${pr.headSha})`);
  if (pr.body && pr.body.trim() !== "") {
    lines.push("");
    lines.push("## PR description");
    lines.push(pr.body.trim());
  }

  lines.push("");
  lines.push("## Changed files and diffs");
  if (files.length === 0) {
    lines.push("(no changed files)");
  }
  for (const file of files) {
    lines.push("");
    lines.push(`### ${file.filename} [${file.status}: +${file.additions}/-${file.deletions}]`);
    if (file.patch) {
      lines.push("```diff");
      lines.push(file.patch);
      lines.push("```");
    } else {
      lines.push("(no inline diff available)");
    }
  }

  if (existingComments.length > 0) {
    lines.push("");
    lines.push("## Existing review comments");
    lines.push("Do not repeat these; focus on new issues.");
    for (const comment of existingComments) {
      lines.push(
        `- ${comment.path}${comment.line !== null ? `:${comment.line}` : ""}: ${sanitize(comment.body)}`,
      );
    }
  } else {
    lines.push("");
    lines.push("## Existing review comments");
    lines.push("(none)");
  }

  return lines.join("\n");
}

function sanitize(value: string): string {
  return value.replace(/\n+/g, " ").slice(0, 500);
}