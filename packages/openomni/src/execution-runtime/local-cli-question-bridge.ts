import { z } from "zod";

interface LocalCliQuestionBridgeRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly residentSessionId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export type LocalCliQuestionBridgeHandler = (
  request: LocalCliQuestionBridgeRequest,
) => Promise<string>;

export interface LocalCliQuestionBridgeServer {
  readonly env: Record<string, string>;
  readonly redactions: readonly string[];
  close(): void;
}

export interface LocalCliQuestionBridgeServerOptions {
  readonly runId: string;
  readonly sessionId: string;
  readonly residentSessionId: string;
  readonly handler?: LocalCliQuestionBridgeHandler;
}

const bridgeRequestSchema = z
  .object({
    prompt: z.string().min(1),
  })
  .strict();

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (authorization?.startsWith(prefix) !== true) return undefined;
  return authorization.slice(prefix.length);
}

function unauthorizedResponse(): Response {
  return textResponse("question bridge unauthorized", 401);
}

function methodNotAllowedResponse(): Response {
  return textResponse("question bridge only accepts POST", 405);
}

async function parsePrompt(request: Request): Promise<string | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return textResponse("question bridge request requires prompt", 400);
  }
  const parsed = bridgeRequestSchema.safeParse(body);
  if (!parsed.success) return textResponse("question bridge request requires prompt", 400);
  return parsed.data.prompt;
}

export function startLocalCliQuestionBridgeServer(
  options: LocalCliQuestionBridgeServerOptions,
): LocalCliQuestionBridgeServer | undefined {
  const handler = options.handler;
  if (handler === undefined) return undefined;

  const token = crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method !== "POST") return methodNotAllowedResponse();
      if (bearerToken(request) !== token) return unauthorizedResponse();
      const prompt = await parsePrompt(request);
      if (prompt instanceof Response) return prompt;
      try {
        const answer = await handler({
          runId: options.runId,
          sessionId: options.sessionId,
          residentSessionId: options.residentSessionId,
          prompt,
          signal: request.signal,
        });
        return textResponse(answer);
      } catch (error) {
        if (error instanceof Error) return textResponse(error.message, 500);
        throw error;
      }
    },
  });

  const url = `http://${server.hostname}:${server.port}`;
  return {
    env: {
      OPENOMNI_QUESTION_BRIDGE_URL: url,
      OPENOMNI_QUESTION_BRIDGE_TOKEN: token,
      OPENOMNI_QUESTION_BRIDGE_RUN_ID: options.runId,
      OPENOMNI_QUESTION_BRIDGE_SESSION_ID: options.sessionId,
      OPENOMNI_QUESTION_BRIDGE_RESIDENT_SESSION_ID: options.residentSessionId,
    },
    redactions: [token],
    close: () => server.stop(true),
  };
}
