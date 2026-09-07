import type { PolicyEvaluationInput } from "@openomni/policy";
import type { BusEvent, Gateway, Inbox, LedgerAction, PlainValue } from "@openomni/protocol";
import type { DeliveryReceipt } from "./messaging/send";

export type ChannelDeliveryRoute = (
  externalId: string,
  content: string,
  idempotencyKey: string,
) => Promise<DeliveryReceipt>;

interface MessageExecution {
  readonly kind: "message";
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  readonly message: NonNullable<PolicyEvaluationInput["message"]>;
}

type MessageExecutionResult = { readonly matchedRuleIds: readonly string[] } & (
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: PlainValue }
  | { readonly terminal: "blocked_post"; readonly reason: string }
);

interface PreparedMessage {
  readonly target: string;
  readonly messageId?: string;
  readonly limits?: { readonly fanout: number; readonly depth: number };
  readonly origin?: Inbox.ReplyOrigin;
  readonly message:
    | Extract<NonNullable<PolicyEvaluationInput["message"]>, { sender: "session" }>
    | { readonly sender: "external"; readonly eventIdUnique: boolean };
  readonly sender?: Inbox.Commit["sender"];
  readonly createSession?: Inbox.Commit["createSession"];
}

export interface GatewayRouterPorts {
  readonly sink: BusEvent.Sink["publish"];
  readonly observe?: (
    sender: Gateway.IngestSender,
    observation: Gateway.MessageObservation,
  ) => void;
  readonly inbox: Inbox.Port;
  /** L1 supplies authenticated facts; the gateway never reads session state. */
  readonly prepare: (
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage,
    target: string,
    messageId: string,
  ) => PreparedMessage;
  readonly run: (
    sender: Gateway.IngestSender,
    request: MessageExecution,
    body: (intent: LedgerAction.Receipt) => Promise<PlainValue>,
  ) => Promise<MessageExecutionResult>;
  readonly committed?: (row: Inbox.Row) => void;
  readonly armDeadline?: (input: {
    messageId: string;
    sessionId: string;
    sourceActionId: string;
    fireAt: number;
    createdAt: number;
    replyTo?: string;
  }) => void;
  readonly clock?: () => number;
  readonly messaging?: {
    readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
    readonly grants: () => readonly Gateway.SenderTargetGrant[];
    readonly budgets?: () => readonly Gateway.SocialBudget[];
    readonly replyGrantRules?: () => readonly Gateway.ReplyGrantRule[];
  };
}

export interface GatewayRouter {
  ingest(
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage | Gateway.IngressFacts,
  ): Promise<Gateway.IngestResult>;
}
