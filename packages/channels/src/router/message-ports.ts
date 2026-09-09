import type { PolicyEvaluationInput } from "@openomni/policy";
import type {
  BusEvent,
  Gateway,
  Inbox,
  LedgerAction,
  PlainValue,
  SessionTransition,
} from "@openomni/protocol";
import type { DeliveryReceipt } from "../support/deliver";

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
  readonly origin?: Inbox.ReplyOrigin | SessionTransition.OutboundMessage;
  readonly message:
    | Extract<NonNullable<PolicyEvaluationInput["message"]>, { sender: "session" }>
    | { readonly sender: "external"; readonly eventIdUnique: boolean };
  readonly sender?: Inbox.Commit["sender"];
  readonly createSession?: Inbox.Commit["createSession"];
}

export interface GatewayRouterPorts {
  /** Authenticate explicit Owner evidence; never infer it from driver trust fields. */
  readonly authenticateAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" },
    credential: string,
    requestId: string,
  ) => Promise<SessionTransition.Principal>;
  readonly requests: {
    list(): readonly SessionTransition.Request[];
    open(input: {
      requestId: string;
      sessionId: string;
      expectedResponders: readonly string[];
      correlation: SessionTransition.Correlation;
      allowedActions: readonly SessionTransition.AllowedAction[];
      resolution: "first" | "quorum" | "all";
      threshold: number;
      deadline: number;
      at: number;
      admission?: Inbox.Commit;
    }): SessionTransition.Request;
    answer(input: SessionTransition.Answer): Promise<SessionTransition.Resolution>;
    receipt(input: SessionTransition.DeliveryReceipt): Promise<SessionTransition.Request>;
  };
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
    message: Gateway.SendMessage | Gateway.IngressFacts | Gateway.RequestAnswer,
  ): Promise<Gateway.IngestResult>;
}
