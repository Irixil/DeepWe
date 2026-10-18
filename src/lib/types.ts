// 前后端共享的类型定义（与后端 src/ai.ts 保持一致）

export interface NvcSummary {
  observation: string;
  feelings: string[];
  needs: string[];
  request: string;
  mock?: boolean;
}

export interface MergedUnderstanding {
  event_summary: string;
  shared_facts: string[];
  a_view: { feelings: string[]; needs: string[]; request: string };
  b_view: { feelings: string[]; needs: string[]; request: string };
  different_views: string[];
  unresolved: string[];
  repair_phrases: { a: string; b: string };
  a_suggestions?: string[];
  a_partner_view?: string;
  a_actions?: string[];
  b_suggestions?: string[];
  b_partner_view?: string;
  b_actions?: string[];
  mock?: boolean;
}

export interface Review {
  executed: string;
  effect: string;
  next: string;
}

export type PartnerUser = Pick<AccountUser, "id" | "displayName">;

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  /** Server-computed owner capability. Client flags never authorize admin APIs. */
  isOwner?: boolean;
  /** Legacy display field only; never use this for authorization or admin UI. */
  isAdmin?: boolean;
  analyticsEnabled?: boolean;
  analyticsNoticeSeen?: boolean;
}

export type PrivateJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface PrivateConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  status: "active" | "deleted";
  lastMessageAt: number | null;
  pendingJobCount: number;
  linkedSide?: "a" | "b" | null;
  linkedEventId?: string | null;
}

export interface PrivateMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  version: number;
  createdAt: number;
  status: "current" | "superseded";
}

export type ReplyFeedbackReason =
  | "natural"
  | "clear"
  | "helpful_advice"
  | "mechanical"
  | "too_many_questions"
  | "too_much_advice"
  | "too_distant"
  | "misunderstood";

export interface PrivateReplyFeedback {
  rating: "up" | "down";
  reason: ReplyFeedbackReason | null;
}

export interface PrivateLatestTurn {
  userMessageId: string | null;
  assistantMessageId: string | null;
}

export interface PrivateNote {
  id: string;
  kind: "user_statement" | "tentative_understanding" | "unknown";
  content: string;
  sourceMessageIds: string[];
  sourceConversationVersion: number;
  version: number;
  status: "current" | "stale" | "corrected";
  correction?: string;
  updatedAt: number;
}

export interface PrivateJob {
  id: string;
  kind: "reply" | "notes" | "share_draft";
  status: PrivateJobStatus;
  inputVersion: number;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
}

export interface PrivateShareDraftSummary {
  id: string;
  version: number;
  status: "draft" | "confirmed" | "converted" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface PrivateConversationDetail {
  conversation: PrivateConversation;
  messages: PrivateMessage[];
  notes: PrivateNote[];
  pendingJob: PrivateJob | null;
  /** Latest job for each kind and every still-running job, including failures. */
  jobs?: PrivateJob[];
  shareDrafts: PrivateShareDraftSummary[];
  latestTurn: PrivateLatestTurn;
  replyFeedback: PrivateReplyFeedback | null;
  responsePreferences: string[];
}

export interface PrivateJobResult {
  job: PrivateJob;
  assistantMessage?: PrivateMessage;
}

export interface PrivateShareDraft {
  id: string;
  content: string;
  version: number;
  status: "draft" | "confirmed" | "converted" | "cancelled";
  sourceMessageIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PrivateShareConfirmation {
  eventId: string;
  shareVersion: number;
  inviteStatus: "pending";
}

export interface AnalyticsFunnelPoint {
  name: string;
  count: number;
  users: number;
}

export interface AnalyticsBreakdownPoint {
  label: string;
  count?: number;
  sessions?: number;
  users: number;
}

export interface AdminAnalyticsDashboard {
  days: 7 | 30 | 90;
  generatedAt: number;
  retentionDays: number;
  privacyThreshold: number;
  overview: { activeUsers: number; sessions: number; events: number };
  funnel: AnalyticsFunnelPoint[];
  conversationFunnel: AnalyticsFunnelPoint[];
  lastSteps: AnalyticsBreakdownPoint[];
  feedbackReasons: AnalyticsBreakdownPoint[];
  outcomes: AnalyticsBreakdownPoint[];
  detailsSuppressed: boolean;
  models: {
    model: string;
    jobKind: string;
    calls: number;
    successful: number;
    failed: number;
    timeouts: number;
    inputTokens: number;
    outputTokens: number;
    averageDurationMs: number;
  }[];
}

export interface AdminRegistrationInvite {
  id: string;
  code: string;
  note: string;
  status: "unused" | "used" | "revoked" | "expired";
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByDisplayName: string | null;
}

export interface PartnerInvite {
  id: string;
  code: string;
  status: "pending" | "approval_pending" | "accepted" | "revoked" | "expired";
  createdAt: number;
  expiresAt: number;
}

export interface PartnerEventInvite {
  id: string;
  title: string;
  inviterName: string;
  createdAt: number;
  expiresAt: number;
  snoozed: boolean;
}

export interface PartnerOverview {
  connection: {
    id: string;
    partner: PartnerUser;
    createdAt: number;
    status: "active" | "paused" | "disconnecting";
    pausedUntil: number | null;
    pausedByMe: boolean;
    disconnectEffectiveAt: number | null;
    disconnectRequestedByMe: boolean;
  } | null;
  outgoingInvite: PartnerInvite | null;
  bindingRequest: {
    id: string;
    counterpart: PartnerUser;
    direction: "incoming" | "outgoing";
    requestedAt: number;
    expiresAt: number;
  } | null;
  archivedConnection: {
    id: string;
    partner: PartnerUser;
    endedAt: number;
    recoverableUntil: number;
    recoveryRequestedByMe: boolean;
    recoveryRequestedByPartner: boolean;
    restoreMemories: boolean;
    memories: SharedSpaceMemory[];
  } | null;
  eventInvites: PartnerEventInvite[];
}

export type SharedMemoryCategory =
  | "communication_method"
  | "support_method"
  | "repair_method"
  | "relationship_priority";

export interface SharedSpaceMemory {
  id: string;
  category: SharedMemoryCategory;
  content: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface SharedSpaceProposal {
  id: string;
  /** Revision of the proposal text that each participant has read. */
  version: number;
  category: SharedMemoryCategory;
  content: string;
  status: "pending" | "rejected";
  proposedByMe: boolean;
  proposedByName: string;
  updatedByMe: boolean;
  updatedByName: string;
  myConfirmed: boolean;
  partnerConfirmed: boolean;
  rejectionReason: string;
  previousContent: string | null;
  nextVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface SharedSpaceOverview {
  partner: PartnerUser;
  memories: SharedSpaceMemory[];
  proposals: SharedSpaceProposal[];
}

export interface AccountEventSummary {
  id: string;
  title: string;
  state: string;
  role: "a" | "b";
  hasPartner: boolean;
  createdAt: number;
  deletionRequestedByMe?: boolean;
  deletionRequestedByPartner?: boolean;
}

export type GuideStage = "story" | "reflection" | "checkin" | "review";

export interface StoryMap {
  context: string;
  timeline: string[];
  words_actions: string[];
  outcome: string;
  feelings: string[];
  impact: string;
  needs: string[];
  expectations: string;
  facts: string[];
  interpretations: string[];
  unknowns: string[];
}

export interface GuideProgress {
  context: boolean;
  timeline: boolean;
  words_actions: boolean;
  outcome: boolean;
  feelings: boolean;
  impact: boolean;
  needs: boolean;
  expectations: boolean;
}

export interface EventData {
  id: string;
  title: string;
  ownConversationId?: string | null;
  code: string;
  inviteMode: "partner_direct" | "legacy_code";
  inviteStatus: "waiting" | "activated" | "withdrawn" | "expired" | null;
  partnerTarget: PartnerUser | null;
  state: string;
  risk: string;
  role: "a" | "b" | "guest";
  analyticsEnabled: boolean;
  aSummary: NvcSummary | null;
  bSummary: NvcSummary | null;
  aConfirmed: boolean;
  bConfirmed: boolean;
  aCorrection: string | null;
  bCorrection: string | null;
  merged: MergedUnderstanding | null;
  /** Version of the shared-understanding snapshot that confirmation must bind to. */
  mergedVersion?: number | null;
  mergedAConfirmed: boolean;
  mergedBConfirmed: boolean;
  choices: { a?: string; b?: string };
  guideMessages: { id: number; role: string; content: string; createdAt: number }[];
  guideStage: GuideStage;
  guideProgress: GuideProgress;
  storyMap: StoryMap | null;
  storyConfirmed: boolean;
  aiJobKind: "guide" | "summary" | "merge_initial" | "merge_correction" | null;
  aiJobId: string | null;
  aiJobAttempt: number | null;
  aiJobStatus: "idle" | "queued" | "processing" | "failed";
  aiJobError: string | null;
  aiJobRetryAllowed: boolean;
  dueAt: number | null;
  reviewAvailable: boolean;
  aReview: Review | null;
  bReview: Review | null;
}
