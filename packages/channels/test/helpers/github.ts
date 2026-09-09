import { createHmac } from "node:crypto";

export function signedWebhook(
  body: string,
  secret: string,
  deliveryId: string,
  event = "issue_comment",
): Request {
  return new Request("http://localhost/github/webhook", {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": signGitHubBody(body, secret),
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    },
  });
}

export function signGitHubBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
