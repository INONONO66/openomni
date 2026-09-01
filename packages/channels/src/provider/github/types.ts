import { z } from "zod";

const GitHubUserSchema = z.object({ login: z.string(), type: z.string() });

const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  // GitHub sends both null and empty-string bodies.
  body: z.string().nullish(),
  // Presence flag only — an issue payload carrying `pull_request` is a PR.
  pull_request: z.object({}).optional(),
  labels: z.array(z.object({ name: z.string() })).optional(),
  user: GitHubUserSchema,
});

const GitHubRepositorySchema = z.object({
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

/**
 * Wire schemas for the two webhook payloads the surface consumes — THE typed
 * boundary where a signature-verified body becomes data. A payload that does
 * not parse is an unsupported event, never a duck-typed walk.
 */
export const GitHubWebhookPayloadSchemas = {
  issue_comment: z.object({
    action: z.string(),
    issue: GitHubIssueSchema,
    comment: z.object({ id: z.number(), body: z.string(), user: GitHubUserSchema }),
    repository: GitHubRepositorySchema,
  }),
  issues: z.object({
    action: z.string(),
    issue: GitHubIssueSchema,
    repository: GitHubRepositorySchema,
  }),
} as const;

export type GitHubUser = z.infer<typeof GitHubUserSchema>;
export type GitHubIssuePayload = z.infer<
  (typeof GitHubWebhookPayloadSchemas)["issues" | "issue_comment"]
>;

export interface GitHubEventContent {
  text: string;
  sender: string;
  senderType: string;
  repo: string;
  issueNumber: number;
  issueKind: "issue" | "pr";
  labels: string[];
}
