import type { Effect } from "effect";
import type { ChannelError } from "../errors";
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
  | { readonly terminal: "interrupted" | "outcome_unknown"; readonly reason: string }
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

type RequestOpenInput = Pick<
  SessionTransition.Request,
  "requestId" | "sessionId" | "correlation" | "resolution" | "threshold" | "deadline"
> & {
  expectedResponders: Readonly<SessionTransition.Request["expectedResponders"]>;
  allowedActions: Readonly<SessionTransition.Request["allowedActions"]>;
  at: number;
  admission?: Inbox.Commit;
};

interface MessagingGrantSources {
  readonly grants: () => readonly Gateway.SenderTargetGrant[];
  /** Absence disables egress budgeting; an empty source instead applies the fail-closed default. */
  readonly budgets?: () => readonly Gateway.SocialBudget[];
}

export interface GatewayRouterPorts {
  /** The app edge executes this synchronous ledger unit without an asynchronous escape. */
  readonly transaction: <A>(operation: Effect.Effect<A, ChannelError>) => Effect.Effect<A, ChannelError>;
  /** Authenticate explicit Owner evidence; never infer it from driver trust fields. */
  readonly authenticateAnswer?: (
    sender: Gateway.IngestSender & { kind: "external" },
    credential: string,
    requestId: string,
  ) => Effect.Effect<SessionTransition.Principal, ChannelError>;
  readonly requests: {
    list(): readonly SessionTransition.Request[];
    open(input: RequestOpenInput): Effect.Effect<SessionTransition.Request, ChannelError>;
    answer(input: SessionTransition.Answer): Effect.Effect<SessionTransition.Resolution, ChannelError>;
    receipt(input: SessionTransition.DeliveryReceipt): Effect.Effect<SessionTransition.Request, ChannelError>;
  };
  readonly sink: BusEvent.Sink["publish"];
  readonly observe?: (
    sender: Gateway.IngestSender,
    observation: Gateway.MessageObservation,
  ) => void;
  readonly inbox: { readonly commit: (input: Inbox.Commit) => Effect.Effect<Inbox.Row, ChannelError> };
  /** L1 supplies authenticated facts; the gateway never reads session state. */
  readonly prepare: (
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage,
    target: string,
    messageId: string,
  ) => Effect.Effect<PreparedMessage, ChannelError>;
  readonly run: (
    sender: Gateway.IngestSender,
    request: MessageExecution,
    body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ChannelError>,
  ) => Effect.Effect<MessageExecutionResult, ChannelError>;
  readonly committed?: (row: Inbox.Row) => void;
  readonly clock?: () => number;
  readonly messaging?: MessagingGrantSources & {
    readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
    readonly replyGrantRules?: () => readonly Gateway.ReplyGrantRule[];
  };
}

export interface GatewayRouter {
  ingest(
    sender: Gateway.IngestSender,
    message: Gateway.SendMessage | Gateway.IngressFacts | Gateway.RequestAnswer,
  ): Effect.Effect<Gateway.IngestResult, ChannelError>;
}
