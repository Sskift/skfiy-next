export const CONVERSATION_HISTORY_SCHEMA_VERSION = 1;

export type ConversationMessageKind =
  | "user-text"
  | "agent-reply"
  | "computer-use-request"
  | "approval"
  | "result"
  | "stopped";

export type ConversationComputerUseState =
  | "none"
  | "requested"
  | "dispatching"
  | "finished"
  | "unknown";

export type ConversationTurnStatus =
  | "pending"
  | "completed"
  | "provider-failed"
  | "denied"
  | "blocked"
  | "failed"
  | "cancelled"
  | "stopped";

export type ConversationTitleSource = "generated" | "user";
export type ConversationApprovalDecision = "required" | "approved" | "denied" | "bypassed";
export type ConversationResultStatus = "completed" | "denied" | "blocked" | "failed" | "cancelled";

export interface ConversationProviderIdentity {
  id: string;
  label: string;
}

export interface ConversationMessageBase {
  id: string;
  turnId: string;
  kind: ConversationMessageKind;
  createdAt: string;
}

export interface ConversationUserTextMessage extends ConversationMessageBase {
  kind: "user-text";
  text: string;
}

export interface ConversationAgentReplyMessage extends ConversationMessageBase {
  kind: "agent-reply";
  text: string;
  provider: ConversationProviderIdentity;
  state: "completed" | "error";
}

export interface ConversationComputerUseRequestMessage extends ConversationMessageBase {
  kind: "computer-use-request";
  text: string;
  toolCallId: string;
  command: string;
  route: string;
}

export interface ConversationApprovalMessage extends ConversationMessageBase {
  kind: "approval";
  text: string;
  toolCallId: string;
  decision: ConversationApprovalDecision;
  reason?: string;
}

export interface ConversationResultMessage extends ConversationMessageBase {
  kind: "result";
  text: string;
  toolCallId: string;
  status: ConversationResultStatus;
  summary: string;
}

export interface ConversationStoppedMessage extends ConversationMessageBase {
  kind: "stopped";
  text: string;
  reason: string;
}

export type ConversationMessage =
  | ConversationUserTextMessage
  | ConversationAgentReplyMessage
  | ConversationComputerUseRequestMessage
  | ConversationApprovalMessage
  | ConversationResultMessage
  | ConversationStoppedMessage;

export interface ConversationTurn {
  id: string;
  submissionId: string;
  attempt: number;
  retryOfTurnId?: string;
  retryRequestId?: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationTurnStatus;
  provider: ConversationProviderIdentity;
  computerUseState: ConversationComputerUseState;
  messages: ConversationMessage[];
}

export interface ConversationSession {
  id: string;
  title: string;
  titleSource: ConversationTitleSource;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
  turns: ConversationTurn[];
}

export interface ConversationHistorySnapshot {
  schemaVersion: typeof CONVERSATION_HISTORY_SCHEMA_VERSION;
  lastActiveSessionId: string | null;
  sessions: ConversationSession[];
}

export interface ConversationRetryPreparation {
  snapshot: ConversationHistorySnapshot;
  sessionId: string;
  turnId: string;
  retryOfTurnId: string;
  submissionId: string;
  userInput: string;
}

export type ConversationRetryResultStatus =
  | "completed"
  | "provider-failed"
  | "cancelled"
  | "computer-use-blocked"
  | "unsafe-retry-blocked"
  | "not-found"
  | "retry-in-progress"
  | "storage-error";

export interface ConversationRetryResult {
  status: ConversationRetryResultStatus;
  message: string;
  snapshot: ConversationHistorySnapshot;
}

export function canRetryConversationTurn(turn: ConversationTurn): boolean {
  return turn.status === "provider-failed" && turn.computerUseState === "none";
}
