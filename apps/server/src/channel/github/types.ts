interface GitHubUser {
  login: string;
  type: string;
}

interface GitHubLabel {
  name: string;
}

interface GitHubRepository {
  full_name: string;
  owner: { login: string };
  name: string;
}

export interface GitHubIssueCommentPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body?: string;
    pull_request?: unknown;
    labels?: GitHubLabel[];
    user: GitHubUser;
  };
  comment: {
    id: number;
    body: string;
    user: GitHubUser;
  };
  repository: GitHubRepository;
}

export interface GitHubIssuesPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body?: string;
    pull_request?: unknown;
    labels?: GitHubLabel[];
    user: GitHubUser;
  };
  repository: GitHubRepository;
}

export interface GitHubEventContent {
  text: string;
  sender: string;
  senderType: string;
  repo: string;
  issueNumber: number;
  issueKind: "issue" | "pr";
  labels: string[];
}
