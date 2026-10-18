import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { MergedUnderstanding } from "./ai.js";

// 数据目录：生产环境用 /tmp（veFaaS 只有 /tmp 可写），本地默认 .data
const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath =
  process.env.DEEPWE_DATABASE_PATH ??
  (process.env.NODE_ENV === "test" ? ":memory:" : path.join(dataDir, "deepwe.db"));

export type EventState =
  | "a_guiding" // A 与 AI 引导式私密剖析中
  | "a_expressing" // 旧版：A 一次性私密表达（保留兼容）
  | "a_summary" // A 摘要已生成，待确认
  | "waiting_b" // A 已确认，等待 B
  | "b_guiding" // B 与 AI 引导式私密剖析中
  | "b_expressing" // 旧版：B 一次性私密表达（保留兼容）
  | "b_summary" // B 摘要已生成，待确认
  | "ready_to_merge" // 双方摘要已确认，待合并
  | "merged" // 共同理解已生成，双方纠偏中
  | "agreement_proposed" // 行动候选已给，待双方选择
  | "done" // 达成行动约定，待复访
  | "completed" // 复访完成
  | "declined" // B 拒绝
  | "cancelled" // A 撤回邀请
  | "sharing_revoked" // 任一参与者撤回已分享内容的授权
  | "closed" // 用户主动结束潜谈，不生成表达
  | "safety_exit"; // 高风险退出

export interface EventRow {
  id: string;
  title: string;
  code: string;
  state: EventState;
  a_token: string;
  b_token: string | null;
  a_user_id: string | null;
  b_user_id: string | null;
  risk_level: string;
  risk_side: "a" | "b" | null;
  created_at: number;
  invite_created_at: number | null;
  partner_target_user_id: string | null;
  invite_mode: "partner_direct" | "legacy_code";
  a_conversation_id: string | null;
  b_conversation_id: string | null;
  a_share_version: number | null;
}

export interface PartnerInvite {
  id: string;
  code: string;
  status: "pending" | "approval_pending" | "accepted" | "revoked" | "expired";
  createdAt: number;
  expiresAt: number;
}

export interface PartnerConnectionView {
  id: string;
  partner: PartnerUser;
  createdAt: number;
  status: "active" | "paused" | "disconnecting";
  pausedUntil: number | null;
  pausedByMe: boolean;
  disconnectEffectiveAt: number | null;
  disconnectRequestedByMe: boolean;
}

export interface PartnerBindingRequest {
  id: string;
  counterpart: PartnerUser;
  direction: "incoming" | "outgoing";
  requestedAt: number;
  expiresAt: number;
}

export interface ArchivedPartnerConnection {
  id: string;
  partner: PartnerUser;
  endedAt: number;
  recoverableUntil: number;
  recoveryRequestedByMe: boolean;
  recoveryRequestedByPartner: boolean;
  restoreMemories: boolean;
  memories: SharedSpaceMemory[];
}

export interface PartnerOverview {
  connection: PartnerConnectionView | null;
  outgoingInvite: PartnerInvite | null;
  bindingRequest: PartnerBindingRequest | null;
  archivedConnection: ArchivedPartnerConnection | null;
}

export interface PartnerEventInvite {
  id: string;
  title: string;
  inviterName: string;
  createdAt: number;
  expiresAt: number;
  snoozed: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  is_admin: number;
  created_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export interface RegistrationInvite {
  id: string;
  code: string;
  note: string;
  status: "unused" | "used" | "revoked" | "expired";
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByDisplayName: string | null;
}

export interface UserEventSummary {
  id: string;
  title: string;
  state: EventState;
  role: "a" | "b";
  hasPartner: boolean;
  createdAt: number;
  deletionRequestedByMe: boolean;
  deletionRequestedByPartner: boolean;
}

export interface PerspectiveRow {
  id: number;
  event_id: string;
  role: "a" | "b";
  raw_text: string;
  summary: string | null;
  summary_confirmed: number;
  correction: string | null;
  created_at: number;
}

export interface MergedRow {
  event_id: string;
  content: string | null;
  a_confirmed: number;
  b_confirmed: number;
  version: number;
}

export interface AgreementRow {
  event_id: string;
  choices: string | null;
  done: number;
  due_at: number | null;
  a_review: string | null;
  b_review: string | null;
}

export interface GuideSessionRow {
  event_id: string;
  side: "a" | "b";
  stage: "story" | "reflection" | "checkin" | "review";
  story_map: string;
  story_confirmed: number;
  updated_at: number;
}

export type PersonalPreferenceCategory =
  | "response_length"
  | "question_pacing"
  | "support_style"
  | "directness"
  | "pause_reminders"
  | "tone"
  | "structure";

export type PersonalPreferenceSetting =
  | "concise"
  | "detailed"
  | "one_at_a_time"
  | "few_questions"
  | "listen_first"
  | "organize_first"
  | "advice_when_asked"
  | "direct"
  | "gentle"
  | "minimal"
  | "welcome"
  | "warm_natural"
  | "neutral_clear"
  | "freeform"
  | "step_by_step";

export interface PersonalPreferenceRow {
  user_id: string;
  category: PersonalPreferenceCategory;
  setting: PersonalPreferenceSetting;
  source_message_id: number | null;
  confidence: number;
  evidence_count: number;
  created_at: number;
  updated_at: number;
}

export interface SharedMemoryRow {
  id: string;
  connection_id: string;
  category: SharedMemoryCategory;
  content: string;
  status: "active" | "archived" | "inactive";
  version: number;
  created_at: number;
  updated_at: number;
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

export type AiJobKind = "guide" | "summary" | "merge_initial" | "merge_correction";
export type AiJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface AiJobRow {
  id: string;
  event_id: string;
  kind: AiJobKind;
  side: GuideSide | null;
  user_message_id: number | null;
  status: AiJobStatus;
  attempts: number;
  error: string | null;
  error_code: string | null;
  source_snapshot: string | null;
  created_at: number;
  updated_at: number;
}

export type AiCallKind = "router" | "guide_fast" | "guide_deep" | "summary" | "merge" | "private_reply" | "private_notes" | "private_share";
export type AiCallStatus = "success" | "failed";

export interface AiCallMetricRow {
  id: string;
  call_kind: AiCallKind;
  provider: string;
  requested_model: string;
  resolved_model: string | null;
  thinking: number;
  attempt: number;
  status: AiCallStatus;
  error_type: string | null;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd_micros: number | null;
  pricing_version: string | null;
  analytics_user_id: string | null;
  analytics_conversation_id: string | null;
  analytics_event_id: string | null;
  created_at: number;
}

export type NewAiCallMetric = Omit<AiCallMetricRow, "id" | "created_at" | "thinking" | "analytics_user_id" | "analytics_conversation_id" | "analytics_event_id"> & {
  thinking: boolean;
  analytics_user_id?: string | null;
  analytics_conversation_id?: string | null;
  analytics_event_id?: string | null;
};

function createDb() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      state TEXT NOT NULL DEFAULT 'a_guiding',
      a_token TEXT NOT NULL,
      b_token TEXT,
      a_user_id TEXT,
      b_user_id TEXT,
      risk_level TEXT NOT NULL DEFAULT 'none',
      risk_side TEXT,
      created_at INTEGER NOT NULL,
      invite_created_at INTEGER,
      partner_target_user_id TEXT,
      invite_mode TEXT NOT NULL DEFAULT 'partner_direct'
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registration_invites (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unused',
      created_by_user_id TEXT NOT NULL,
      used_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS partner_connections (
      id TEXT PRIMARY KEY,
      user_one_id TEXT NOT NULL,
      user_two_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      ended_by_user_id TEXT,
      paused_until INTEGER,
      paused_by_user_id TEXT,
      disconnect_requested_at INTEGER,
      disconnect_effective_at INTEGER,
      disconnect_requested_by_user_id TEXT,
      recovery_requested_at INTEGER,
      recovery_requested_by_user_id TEXT,
      recovery_restore_memories INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS partner_invites (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      inviter_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      accepted_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS personal_preferences (
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      setting TEXT NOT NULL,
      source_message_id INTEGER,
      confidence REAL NOT NULL DEFAULT 0.7,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, category)
    );
    CREATE TABLE IF NOT EXISTS shared_memories (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      a_confirmed INTEGER NOT NULL DEFAULT 1,
      b_confirmed INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(connection_id, category)
    );
    CREATE TABLE IF NOT EXISTS shared_memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL,
      confirmed_at INTEGER NOT NULL,
      UNIQUE(memory_id, version)
    );
    CREATE TABLE IF NOT EXISTS shared_memory_proposals (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      proposed_by_user_id TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      replaces_memory_id TEXT,
      a_confirmed INTEGER NOT NULL DEFAULT 0,
      b_confirmed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      rejected_by_user_id TEXT,
      rejection_reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS message_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      side TEXT NOT NULL,
      user_message_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS perspectives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      role TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      summary TEXT,
      summary_confirmed INTEGER NOT NULL DEFAULT 0,
      correction TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(event_id, role)
    );
    CREATE TABLE IF NOT EXISTS merged (
      event_id TEXT PRIMARY KEY,
      content TEXT,
      a_confirmed INTEGER NOT NULL DEFAULT 0,
      b_confirmed INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS agreements (
      event_id TEXT PRIMARY KEY,
      choices TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER,
      a_review TEXT,
      b_review TEXT
    );
    CREATE TABLE IF NOT EXISTS guide_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      side TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guide_sessions (
      event_id TEXT NOT NULL,
      side TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'story',
      story_map TEXT NOT NULL,
      story_confirmed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(event_id, side)
    );
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      side TEXT,
      user_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      error_code TEXT,
      source_snapshot TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_call_metrics (
      id TEXT PRIMARY KEY,
      call_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      thinking INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_type TEXT,
      latency_ms INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      reasoning_tokens INTEGER,
      cached_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost_usd_micros INTEGER,
      pricing_version TEXT,
      analytics_user_id TEXT,
      analytics_conversation_id TEXT,
      analytics_event_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_conversations (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_message_at INTEGER,
      linked_event_id TEXT, linked_side TEXT, client_request_id TEXT
    );
    CREATE TABLE IF NOT EXISTS private_risk_state (
      conversation_id TEXT PRIMARY KEY, situation TEXT NOT NULL, source_message_ids TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'current',
      created_at INTEGER NOT NULL, client_request_id TEXT, is_safety_response INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS private_reply_feedback (
      owner_user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, source_message_version INTEGER NOT NULL,
      assistant_message_id TEXT NOT NULL, assistant_message_version INTEGER NOT NULL,
      rating TEXT NOT NULL CHECK(rating IN ('up','down')),
      reason TEXT CHECK(reason IS NULL OR reason IN ('natural','clear','helpful_advice','mechanical','too_many_questions','too_much_advice','too_distant','misunderstood')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(owner_user_id, conversation_id, assistant_message_id)
    );
    CREATE INDEX IF NOT EXISTS private_reply_feedback_scope_idx
      ON private_reply_feedback(owner_user_id, conversation_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS private_messages_idempotency_idx
      ON private_messages(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS private_notes (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      source_message_ids TEXT NOT NULL, source_message_versions TEXT NOT NULL,
      source_conversation_version INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'current', correction TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_share_drafts (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, content TEXT NOT NULL,
      source_message_ids TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      event_id TEXT
    );
    CREATE TABLE IF NOT EXISTS private_jobs (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL, input_version INTEGER NOT NULL, source_message_id TEXT,
      source_message_version INTEGER, payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued', error_code TEXT, result_message_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_memory_settings (
      owner_user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS private_memory_items (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      source_conversation_id TEXT NOT NULL, source_note_id TEXT NOT NULL,
      source_message_ids TEXT NOT NULL, source_message_versions TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL, correction TEXT, correction_metadata TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'current', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner_user_id, source_note_id)
    );
    CREATE INDEX IF NOT EXISTS private_memory_owner_idx ON private_memory_items(owner_user_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS private_memory_tombstones (
      owner_user_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(owner_user_id, source_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS private_memory_cutoff_sources (
      owner_user_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_message_version INTEGER NOT NULL,
      superseded_by_message_id TEXT, superseded_by_message_version INTEGER,
      PRIMARY KEY(owner_user_id, source_message_id)
    );
    CREATE INDEX IF NOT EXISTS private_jobs_queue_idx ON private_jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
      event_id TEXT, name TEXT NOT NULL, screen TEXT, step TEXT, result TEXT, reason TEXT,
      duration_ms INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_user_visibility (
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      hidden_at INTEGER NOT NULL,
      PRIMARY KEY(event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS event_deletion_requests (
      event_id TEXT PRIMARY KEY,
      requested_by_user_id TEXT NOT NULL,
      a_confirmed INTEGER NOT NULL DEFAULT 0,
      b_confirmed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partner_event_invite_snoozes (
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      snoozed_at INTEGER NOT NULL,
      PRIMARY KEY(event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS ai_jobs_status_created_idx
      ON ai_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS ai_jobs_event_created_idx
      ON ai_jobs(event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ai_call_metrics_created_idx
      ON ai_call_metrics(created_at DESC);
    CREATE INDEX IF NOT EXISTS ai_call_metrics_model_created_idx
      ON ai_call_metrics(provider, requested_model, created_at DESC);
    CREATE INDEX IF NOT EXISTS account_sessions_user_idx
      ON account_sessions(user_id);
    CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
      ON account_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS registration_invites_creator_idx
      ON registration_invites(created_by_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS registration_invites_status_idx
      ON registration_invites(status, expires_at);
    CREATE INDEX IF NOT EXISTS password_reset_user_idx
      ON password_reset_codes(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS message_feedback_event_idx
      ON message_feedback(event_id, side, created_at DESC);
    CREATE INDEX IF NOT EXISTS partner_connections_users_idx
      ON partner_connections(user_one_id, user_two_id, status);
    CREATE INDEX IF NOT EXISTS partner_invites_inviter_idx
      ON partner_invites(inviter_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS partner_invites_status_idx
      ON partner_invites(status, expires_at);
    CREATE INDEX IF NOT EXISTS personal_preferences_user_idx
      ON personal_preferences(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS shared_memories_connection_idx
      ON shared_memories(connection_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS shared_memory_versions_connection_idx
      ON shared_memory_versions(connection_id, category, version DESC);
    CREATE INDEX IF NOT EXISTS shared_memory_proposals_connection_idx
      ON shared_memory_proposals(connection_id, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS shared_memory_proposals_pending_unique
      ON shared_memory_proposals(connection_id, category) WHERE status = 'pending';
  `);
  // 兼容已经存在的本地 V1.0 数据库。新增归属列保持可空，旧事件继续使用原角色令牌。
  const eventColumns = db.pragma("table_info(events)") as { name: string }[];
  if (!eventColumns.some((column) => column.name === "a_user_id")) {
    db.exec("ALTER TABLE events ADD COLUMN a_user_id TEXT");
  }
  if (!eventColumns.some((column) => column.name === "b_user_id")) {
    db.exec("ALTER TABLE events ADD COLUMN b_user_id TEXT");
  }
  if (!eventColumns.some((column) => column.name === "invite_created_at")) {
    db.exec("ALTER TABLE events ADD COLUMN invite_created_at INTEGER");
  }
  if (!eventColumns.some((column) => column.name === "partner_target_user_id")) {
    db.exec("ALTER TABLE events ADD COLUMN partner_target_user_id TEXT");
  }
  if (!eventColumns.some((column) => column.name === "invite_mode")) {
    db.exec("ALTER TABLE events ADD COLUMN invite_mode TEXT NOT NULL DEFAULT 'legacy_code'");
  }
  if (!eventColumns.some((column) => column.name === "risk_side")) {
    db.exec("ALTER TABLE events ADD COLUMN risk_side TEXT");
  }
  db.exec("UPDATE events SET invite_created_at = created_at WHERE invite_created_at IS NULL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS events_a_user_idx ON events(a_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS events_b_user_idx ON events(b_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS events_partner_target_idx ON events(partner_target_user_id, state, created_at DESC);
  `);
  const userColumns = db.pragma("table_info(users)") as { name: string }[];
  if (!userColumns.some((column) => column.name === "is_admin")) {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  for (const [name, definition] of [
    ["analytics_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["analytics_notice_seen", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!userColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
  }
  const metricColumns = db.pragma("table_info(ai_call_metrics)") as { name: string }[];
  if (!metricColumns.some((column) => column.name === "analytics_user_id")) {
    db.exec("ALTER TABLE ai_call_metrics ADD COLUMN analytics_user_id TEXT");
  }
  if (!metricColumns.some((column) => column.name === "analytics_conversation_id")) {
    db.exec("ALTER TABLE ai_call_metrics ADD COLUMN analytics_conversation_id TEXT");
  }
  if (!metricColumns.some((column) => column.name === "analytics_event_id")) {
    db.exec("ALTER TABLE ai_call_metrics ADD COLUMN analytics_event_id TEXT");
  }
  const aiJobColumns = db.pragma("table_info(ai_jobs)") as { name: string }[];
  if (!aiJobColumns.some((column) => column.name === "source_snapshot")) {
    db.exec("ALTER TABLE ai_jobs ADD COLUMN source_snapshot TEXT");
  }
  if (!aiJobColumns.some((column) => column.name === "error_code")) {
    db.exec("ALTER TABLE ai_jobs ADD COLUMN error_code TEXT");
    db.prepare(
      `UPDATE ai_jobs SET error_code = 'AI_RESULT_UNKNOWN', error = ?
       WHERE status = 'failed' AND kind IN ('merge_initial', 'merge_correction')`
    ).run("共同理解未完成。双方确认的摘要已保存；上一次请求结果尚不确定，暂不会自动重新生成。你可以刷新查看状态。");
  }
  const eventColumnsForConversation = db.pragma("table_info(events)") as { name: string }[];
  for (const [name, definition] of [["a_conversation_id", "TEXT"], ["b_conversation_id", "TEXT"], ["a_share_version", "INTEGER"]] as const) {
    if (!eventColumnsForConversation.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
    }
  }
  const preferenceColumns = db.pragma("table_info(personal_preferences)") as { name: string }[];
  if (!preferenceColumns.some((column) => column.name === "source_message_id")) {
    db.exec("ALTER TABLE personal_preferences ADD COLUMN source_message_id INTEGER");
  }
  const connectionColumns = db.pragma("table_info(partner_connections)") as { name: string }[];
  for (const [name, definition] of [
    ["paused_until", "INTEGER"],
    ["paused_by_user_id", "TEXT"],
    ["disconnect_requested_at", "INTEGER"],
    ["disconnect_effective_at", "INTEGER"],
    ["disconnect_requested_by_user_id", "TEXT"],
    ["recovery_requested_at", "INTEGER"],
    ["recovery_requested_by_user_id", "TEXT"],
    ["recovery_restore_memories", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!connectionColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE partner_connections ADD COLUMN ${name} ${definition}`);
    }
  }
  const sharedMemoryColumns = db.pragma("table_info(shared_memories)") as { name: string }[];
  if (!sharedMemoryColumns.some((column) => column.name === "version")) {
    db.exec("ALTER TABLE shared_memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }
  const sharedProposalColumns = db.pragma("table_info(shared_memory_proposals)") as { name: string }[];
  if (!sharedProposalColumns.some((column) => column.name === "version")) {
    db.exec("ALTER TABLE shared_memory_proposals ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }
  const privateMessageColumns = db.pragma("table_info(private_messages)") as { name: string }[];
  if (!privateMessageColumns.some((column) => column.name === "is_safety_response")) {
    db.exec("ALTER TABLE private_messages ADD COLUMN is_safety_response INTEGER NOT NULL DEFAULT 0");
  }
  const privateMemoryColumns = db.pragma("table_info(private_memory_items)") as { name: string }[];
  if (!privateMemoryColumns.some((column) => column.name === "correction_metadata")) {
    db.exec("ALTER TABLE private_memory_items ADD COLUMN correction_metadata TEXT");
  }
  const privateMemoryCutoffColumns = db.pragma("table_info(private_memory_cutoff_sources)") as { name: string }[];
  for (const [name, definition] of [["superseded_by_message_id", "TEXT"], ["superseded_by_message_version", "INTEGER"]] as const) {
    if (!privateMemoryCutoffColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE private_memory_cutoff_sources ADD COLUMN ${name} ${definition}`);
  }
  const privateConversationColumns = db.pragma("table_info(private_conversations)") as { name: string }[];
  if (!privateConversationColumns.some((column) => column.name === "client_request_id")) {
    db.exec("ALTER TABLE private_conversations ADD COLUMN client_request_id TEXT");
  }
  db.exec(`
    INSERT OR IGNORE INTO shared_memory_versions
      (id, memory_id, connection_id, category, content, version, confirmed_at)
    SELECT id || '-v' || version, id, connection_id, category, content, version, updated_at
    FROM shared_memories
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS private_conversations_owner_idx ON private_conversations(owner_user_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS private_conversations_idempotency_idx ON private_conversations(owner_user_id, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS private_messages_conversation_idx ON private_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS private_notes_conversation_idx ON private_notes(conversation_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS private_share_drafts_conversation_idx ON private_share_drafts(conversation_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events(created_at);
    CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events(user_id, created_at DESC);`);
  // 旧版 review 会自动展示整理结果；未真正生成摘要的会话恢复为普通潜谈。
  db.prepare(
    `UPDATE guide_sessions SET stage = 'checkin'
     WHERE stage = 'review' AND story_confirmed = 0`
  ).run();
  return db;
}

const g = globalThis as unknown as { __deepweDb?: ReturnType<typeof createDb> };
export const db = g.__deepweDb ?? (g.__deepweDb = createDb());

export function applyConfiguredAdminFromEnvironment(): void {
  // Authorization is derived from the exact configured user ID at request time.
}

function now(): number {
  return Date.now();
}

export function randomCode(len = 4): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function recordAiCallMetric(metric: NewAiCallMetric): AiCallMetricRow {
  if (metric.analytics_conversation_id) {
    const eligible = db.prepare(`SELECT 1 FROM private_conversations c JOIN users u ON u.id=c.owner_user_id
      WHERE c.id=? AND c.owner_user_id=? AND c.status='active' AND u.analytics_enabled=1 AND u.analytics_notice_seen=1`)
      .get(metric.analytics_conversation_id, metric.analytics_user_id ?? "");
    if (!eligible) throw new Error("analytics consent or conversation ownership unavailable");
  }
  if (metric.analytics_event_id) {
    const eligible=db.prepare(`SELECT 1 FROM events e
      JOIN users a ON a.id=e.a_user_id AND a.analytics_enabled=1 AND a.analytics_notice_seen=1
      JOIN users b ON b.id=e.b_user_id AND b.analytics_enabled=1 AND b.analytics_notice_seen=1
      WHERE e.id=?`).get(metric.analytics_event_id);
    if(!eligible)throw new Error("both event participants must consent to analytics");
  }
  const id = crypto.randomUUID();
  const createdAt = now();
  db.prepare(
    `INSERT INTO ai_call_metrics
      (id, call_kind, provider, requested_model, resolved_model, thinking, attempt,
       status, error_type, latency_ms, prompt_tokens, completion_tokens,
       reasoning_tokens, cached_tokens, total_tokens, estimated_cost_usd_micros,
       pricing_version, analytics_user_id, analytics_conversation_id, analytics_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    metric.call_kind,
    metric.provider,
    metric.requested_model,
    metric.resolved_model,
    metric.thinking ? 1 : 0,
    metric.attempt,
    metric.status,
    metric.error_type,
    metric.latency_ms,
    metric.prompt_tokens,
    metric.completion_tokens,
    metric.reasoning_tokens,
    metric.cached_tokens,
    metric.total_tokens,
    metric.estimated_cost_usd_micros,
    metric.pricing_version,
    metric.analytics_user_id ?? null,
    metric.analytics_conversation_id ?? null,
    metric.analytics_event_id ?? null,
    createdAt
  );
  return db.prepare(`SELECT * FROM ai_call_metrics WHERE id = ?`).get(id) as AiCallMetricRow;
}

export function listAiCallMetricsSince(createdAt: number): AiCallMetricRow[] {
  return db.prepare(
    `SELECT * FROM ai_call_metrics WHERE created_at >= ? ORDER BY created_at, attempt`
  ).all(createdAt) as AiCallMetricRow[];
}

export const ANALYTICS_RETENTION_MS = 90 * 86400000;

// Use one 90-day deadline for both scheduled and synchronous pruning.
// This removes only analytics rows; conversation and shared content are separate.
export function pruneExpiredAnalytics(referenceTime = now()): { analyticsEvents: number; aiCallMetrics: number } {
  const cutoff = referenceTime - ANALYTICS_RETENTION_MS;
  return db.transaction(() => ({
    analyticsEvents: db.prepare(`DELETE FROM analytics_events WHERE created_at <= ?`).run(cutoff).changes,
    aiCallMetrics: db.prepare(`DELETE FROM ai_call_metrics WHERE created_at <= ?`).run(cutoff).changes,
  }))();
}

// ---------- accounts ----------

export function createUser(
  email: string,
  displayName: string,
  passwordHash: string,
  passwordSalt: string,
  isAdmin = false
): UserRow {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users
      (id, email, display_name, password_hash, password_salt, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, email, displayName, passwordHash, passwordSalt, isAdmin ? 1 : 0, now());
  return getUserById(id)!;
}

export function countUsers(): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM users`).get() as { count: number };
  return Number(row.count);
}

export function countAdminUsers(): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE is_admin = 1`).get() as { count: number };
  return Number(row.count);
}

export function getUserById(id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined;
}

export type PartnerUser = Pick<PublicUser, "id" | "displayName">;

function publicPartner(user: UserRow): PartnerUser {
  return { id: user.id, displayName: user.display_name };
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    isAdmin: !!user.is_admin,
  };
}

const PERSONAL_PREFERENCE_OPTIONS: Record<
  PersonalPreferenceCategory,
  readonly PersonalPreferenceSetting[]
> = {
  response_length: ["concise", "detailed"],
  question_pacing: ["one_at_a_time", "few_questions"],
  support_style: ["listen_first", "organize_first", "advice_when_asked"],
  directness: ["direct", "gentle"],
  pause_reminders: ["minimal", "welcome"],
  tone: ["warm_natural", "neutral_clear"],
  structure: ["freeform", "step_by_step"],
};

const PERSONAL_PREFERENCE_DESCRIPTIONS: Record<PersonalPreferenceSetting, string> = {
  concise: "回答尽量简短，保留最重要的一层",
  detailed: "需要时可以讲得更完整、更细致",
  one_at_a_time: "一次最多问一个问题",
  few_questions: "少追问，允许用户连续表达",
  listen_first: "先倾听和理解，再考虑整理或建议",
  organize_first: "用户表达混乱时可以帮助梳理重点",
  advice_when_asked: "只有用户主动需要时再给行动建议",
  direct: "表达可以直接清楚一些",
  gentle: "表达保持柔和，避免过强的结论感",
  minimal: "非必要不主动重复暂停提醒",
  welcome: "情绪很高时可以适度提醒暂停选择",
  warm_natural: "使用自然、有温度的日常中文，避免机械复述",
  neutral_clear: "使用中性、清楚、克制的表达",
  freeform: "允许自由表达，不强制按步骤回答",
  step_by_step: "适合一次只处理一个小步骤",
};

function validPersonalPreference(
  category: string,
  setting: string
): category is PersonalPreferenceCategory {
  const options = PERSONAL_PREFERENCE_OPTIONS[category as PersonalPreferenceCategory];
  return !!options?.includes(setting as PersonalPreferenceSetting);
}

export function upsertPersonalPreference(
  userId: string,
  category: string,
  setting: string,
  sourceMessageId: number | null = null
): PersonalPreferenceRow | null {
  if (!getUserById(userId) || !validPersonalPreference(category, setting)) return null;
  const timestamp = now();
  db.prepare(
    `INSERT INTO personal_preferences
      (user_id, category, setting, source_message_id, confidence, evidence_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0.45, 1, ?, ?)
     ON CONFLICT(user_id, category) DO UPDATE SET
       confidence = CASE
         WHEN excluded.source_message_id IS NOT NULL
           AND personal_preferences.source_message_id = excluded.source_message_id
           THEN personal_preferences.confidence
         WHEN personal_preferences.setting = excluded.setting
           THEN MIN(0.95, personal_preferences.confidence + 0.08)
         ELSE 0.82
       END,
       evidence_count = CASE
         WHEN excluded.source_message_id IS NOT NULL
           AND personal_preferences.source_message_id = excluded.source_message_id
           THEN personal_preferences.evidence_count
         WHEN personal_preferences.setting = excluded.setting
           THEN personal_preferences.evidence_count + 1
         ELSE 2
       END,
       setting = excluded.setting,
       source_message_id = excluded.source_message_id,
       updated_at = excluded.updated_at`
  ).run(userId, category, setting, sourceMessageId, timestamp, timestamp);
  return db
    .prepare(`SELECT * FROM personal_preferences WHERE user_id = ? AND category = ?`)
    .get(userId, category) as PersonalPreferenceRow;
}

export function listPersonalPreferences(userId: string): PersonalPreferenceRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM personal_preferences
       WHERE user_id = ? ORDER BY updated_at DESC, category ASC`
    )
    .all(userId) as PersonalPreferenceRow[];
  return rows.filter((row) => validPersonalPreference(row.category, row.setting));
}

export function describePersonalPreferences(userId: string): string[] {
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  return listPersonalPreferences(userId)
    .filter((preference) => preference.evidence_count >= 2 && now() - preference.updated_at <= ninetyDays)
    .map((preference) => PERSONAL_PREFERENCE_DESCRIPTIONS[preference.setting]);
}

function normalizeRegistrationCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function createRegistrationInvite(
  createdByUserId: string,
  note: string,
  ttlMs = 7 * 24 * 60 * 60 * 1000
): RegistrationInvite {
  let code = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    code = randomCode(8);
    const exists = db.prepare(`SELECT 1 FROM registration_invites WHERE code = ?`).get(code);
    if (!exists) break;
  }
  const id = crypto.randomUUID();
  const createdAt = now();
  db.prepare(
    `INSERT INTO registration_invites
      (id, code, note, status, created_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, 'unused', ?, ?, ?)`
  ).run(id, code, note, createdByUserId, createdAt, createdAt + ttlMs);
  return listRegistrationInvites(createdByUserId).find((invite) => invite.id === id)!;
}

export function listRegistrationInvites(createdByUserId: string): RegistrationInvite[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.note, i.status, i.created_at, i.expires_at, i.used_at,
              u.display_name AS used_by_display_name
       FROM registration_invites i
       LEFT JOIN users u ON u.id = i.used_by_user_id
       WHERE i.created_by_user_id = ? AND i.status <> 'revoked'
       ORDER BY i.created_at DESC`
    )
    .all(createdByUserId) as {
      id: string;
      code: string;
      note: string;
      status: RegistrationInvite["status"];
      created_at: number;
      expires_at: number;
      used_at: number | null;
      used_by_display_name: string | null;
    }[];
  const timestamp = now();
  return rows.map((row) => ({
    id: row.id,
    code: `${row.code.slice(0, 4)}-${row.code.slice(4)}`,
    note: row.note,
    status: row.status === "unused" && row.expires_at <= timestamp ? "expired" : row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedByDisplayName: row.used_by_display_name,
  }));
}

export function revokeRegistrationInvite(id: string, createdByUserId: string): boolean {
  const result = db
    .prepare(
      `UPDATE registration_invites SET status = 'revoked'
       WHERE id = ? AND created_by_user_id = ? AND status = 'unused'`
    )
    .run(id, createdByUserId);
  return result.changes > 0;
}

export function createUserWithRegistrationInvite(
  code: string,
  email: string,
  displayName: string,
  passwordHash: string,
  passwordSalt: string
): UserRow | null {
  return db.transaction(() => {
    const normalized = normalizeRegistrationCode(code);
    const timestamp = now();
    const invite = db
      .prepare(
        `SELECT id FROM registration_invites
         WHERE code = ? AND status = 'unused' AND expires_at > ?`
      )
      .get(normalized, timestamp) as { id: string } | undefined;
    if (!invite) return null;

    const user = createUser(email, displayName, passwordHash, passwordSalt, false);
    const consumed = db
      .prepare(
        `UPDATE registration_invites
         SET status = 'used', used_by_user_id = ?, used_at = ?
         WHERE id = ? AND status = 'unused'`
      )
      .run(user.id, timestamp, invite.id);
    if (consumed.changes === 0) throw new Error("registration invite was already used");
    return user;
  })();
}

type PartnerConnectionRow = {
  id: string;
  user_one_id: string;
  user_two_id: string;
  status: "active" | "disconnecting" | "ended";
  created_at: number;
  ended_at: number | null;
  ended_by_user_id: string | null;
  paused_until: number | null;
  paused_by_user_id: string | null;
  disconnect_requested_at: number | null;
  disconnect_effective_at: number | null;
  disconnect_requested_by_user_id: string | null;
  recovery_requested_at: number | null;
  recovery_requested_by_user_id: string | null;
  recovery_restore_memories: number;
};

const PARTNER_DISCONNECT_GRACE_MS = 24 * 60 * 60 * 1000;
const PARTNER_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function finalizeDuePartnerConnections(): void {
  const timestamp = now();
  db.prepare(
    `UPDATE partner_connections
     SET paused_until = NULL, paused_by_user_id = NULL
     WHERE status = 'active' AND paused_until IS NOT NULL AND paused_until <= ?`
  ).run(timestamp);
  const due = db.prepare(
    `SELECT * FROM partner_connections
     WHERE status = 'disconnecting' AND disconnect_effective_at <= ?`
  ).all(timestamp) as PartnerConnectionRow[];
  for (const connection of due) {
    db.transaction(() => {
      db.prepare(
        `UPDATE partner_connections
         SET status = 'ended', ended_at = ?, ended_by_user_id = disconnect_requested_by_user_id,
             paused_until = NULL, paused_by_user_id = NULL
         WHERE id = ? AND status = 'disconnecting'`
      ).run(timestamp, connection.id);
      db.prepare(
        `UPDATE shared_memories SET status = 'archived', updated_at = ?
         WHERE connection_id = ? AND status = 'active'`
      ).run(timestamp, connection.id);
      db.prepare(
        `UPDATE shared_memory_proposals SET status = 'inactive', updated_at = ?
         WHERE connection_id = ? AND status IN ('pending', 'rejected')`
      ).run(timestamp, connection.id);
      db.prepare(
        `UPDATE events SET state = 'cancelled', partner_target_user_id = NULL
         WHERE state = 'waiting_b'
           AND ((a_user_id = ? AND partner_target_user_id = ?)
             OR (a_user_id = ? AND partner_target_user_id = ?))`
      ).run(
        connection.user_one_id,
        connection.user_two_id,
        connection.user_two_id,
        connection.user_one_id
      );
    })();
  }
}

function currentPartnerConnection(userId: string): PartnerConnectionRow | undefined {
  finalizeDuePartnerConnections();
  return db.prepare(
    `SELECT * FROM partner_connections
     WHERE status IN ('active', 'disconnecting') AND (user_one_id = ? OR user_two_id = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).get(userId, userId) as PartnerConnectionRow | undefined;
}

function activePartnerConnection(userId: string): PartnerConnectionRow | undefined {
  const connection = currentPartnerConnection(userId);
  if (!connection || connection.status !== "active") return undefined;
  if (connection.paused_until && connection.paused_until > now()) return undefined;
  return connection;
}

export function getActivePartnerUserId(userId: string): string | null {
  const connection = activePartnerConnection(userId);
  if (!connection) return null;
  return connection.user_one_id === userId ? connection.user_two_id : connection.user_one_id;
}

export function getActivePartnerConnectionId(userId: string): string | null {
  return activePartnerConnection(userId)?.id ?? null;
}

const SHARED_MEMORY_CATEGORIES: readonly SharedMemoryCategory[] = [
  "communication_method",
  "support_method",
  "repair_method",
  "relationship_priority",
];

function validSharedMemoryCategory(category: string): category is SharedMemoryCategory {
  return SHARED_MEMORY_CATEGORIES.includes(category as SharedMemoryCategory);
}

function cleanSharedMemoryContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 300);
}

function connectionMemberSide(
  connection: { user_one_id: string; user_two_id: string },
  userId: string
): "one" | "two" | null {
  if (connection.user_one_id === userId) return "one";
  if (connection.user_two_id === userId) return "two";
  return null;
}

export function upsertConfirmedSharedMemory(
  connectionId: string,
  category: string,
  content: string
): SharedMemoryRow | null {
  const cleanCategory = category.trim();
  const cleanContent = cleanSharedMemoryContent(content);
  if (!validSharedMemoryCategory(cleanCategory) || !cleanContent) return null;
  const active = db
    .prepare(`SELECT 1 FROM partner_connections WHERE id = ? AND status = 'active'`)
    .get(connectionId);
  if (!active) return null;
  const timestamp = now();
  const existing = db
    .prepare(`SELECT id, version FROM shared_memories WHERE connection_id = ? AND category = ?`)
    .get(connectionId, cleanCategory) as { id: string; version: number } | undefined;
  const id = existing?.id ?? crypto.randomUUID();
  const version = (existing?.version ?? 0) + 1;
  if (existing) {
    db.prepare(
      `UPDATE shared_memories
       SET content = ?, a_confirmed = 1, b_confirmed = 1, status = 'active',
           version = ?, updated_at = ?
       WHERE id = ?`
    ).run(cleanContent, version, timestamp, id);
  } else {
    db.prepare(
      `INSERT INTO shared_memories
        (id, connection_id, category, content, a_confirmed, b_confirmed, status,
         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 1, 1, 'active', ?, ?, ?)`
    ).run(id, connectionId, cleanCategory, cleanContent, timestamp, timestamp, version);
  }
  db.prepare(
    `INSERT INTO shared_memory_versions
      (id, memory_id, connection_id, category, content, version, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), id, connectionId, cleanCategory, cleanContent, version, timestamp);
  return db.prepare(`SELECT id, connection_id, category, content, status, version, created_at, updated_at
                     FROM shared_memories WHERE id = ?`).get(id) as SharedMemoryRow;
}

export function listSharedMemoriesForUser(userId: string): SharedMemoryRow[] {
  return db
    .prepare(
      `SELECT memory.id, memory.connection_id, memory.category, memory.content,
              memory.status, memory.version, memory.created_at, memory.updated_at
       FROM shared_memories memory
       JOIN partner_connections connection ON connection.id = memory.connection_id
       WHERE connection.status = 'active'
         AND (connection.user_one_id = ? OR connection.user_two_id = ?)
         AND memory.status = 'active'
         AND memory.a_confirmed = 1
         AND memory.b_confirmed = 1
       ORDER BY memory.updated_at DESC`
    )
    .all(userId, userId) as SharedMemoryRow[];
}

export function getSharedSpaceForUser(userId: string): SharedSpaceOverview | null {
  const connection = currentPartnerConnection(userId);
  if (!connection || connection.status !== "active") return null;
  const partnerId = connection.user_one_id === userId ? connection.user_two_id : connection.user_one_id;
  const partner = getUserById(partnerId);
  if (!partner) return null;

  const proposals = db
    .prepare(
      `SELECT proposal.*, proposer.display_name AS proposer_name,
              updater.display_name AS updater_name,
              previous.content AS previous_content,
              previous.version AS previous_version
       FROM shared_memory_proposals proposal
       JOIN users proposer ON proposer.id = proposal.proposed_by_user_id
       JOIN users updater ON updater.id = proposal.updated_by_user_id
       LEFT JOIN shared_memories previous ON previous.id = proposal.replaces_memory_id
       WHERE proposal.connection_id = ? AND proposal.status IN ('pending', 'rejected')
       ORDER BY proposal.updated_at DESC LIMIT 20`
    )
    .all(connection.id) as Array<{
      id: string;
      version: number;
      category: string;
      content: string;
      status: "pending" | "rejected";
      proposed_by_user_id: string;
      updated_by_user_id: string;
      proposer_name: string;
      updater_name: string;
      a_confirmed: number;
      b_confirmed: number;
      rejection_reason: string;
      previous_content: string | null;
      previous_version: number | null;
      created_at: number;
      updated_at: number;
    }>;
  const mySide = connectionMemberSide(connection, userId)!;

  return {
    partner: publicPartner(partner),
    memories: listSharedMemoriesForUser(userId).map((memory) => ({
      id: memory.id,
      category: memory.category,
      content: memory.content,
      createdAt: memory.created_at,
      updatedAt: memory.updated_at,
      version: memory.version,
    })),
    proposals: proposals
      .filter((proposal) => validSharedMemoryCategory(proposal.category))
      .map((proposal) => ({
        id: proposal.id,
        version: proposal.version,
        category: proposal.category as SharedMemoryCategory,
        content: proposal.content,
        status: proposal.status,
        proposedByMe: proposal.proposed_by_user_id === userId,
        proposedByName: proposal.proposer_name,
        updatedByMe: proposal.updated_by_user_id === userId,
        updatedByName: proposal.updater_name,
        myConfirmed: !!(mySide === "one" ? proposal.a_confirmed : proposal.b_confirmed),
        partnerConfirmed: !!(mySide === "one" ? proposal.b_confirmed : proposal.a_confirmed),
        rejectionReason: proposal.rejection_reason,
        previousContent: proposal.previous_content,
        nextVersion: (proposal.previous_version ?? 0) + 1,
        createdAt: proposal.created_at,
        updatedAt: proposal.updated_at,
      })),
  };
}

export function createSharedMemoryProposal(
  userId: string,
  category: string,
  content: string
): SharedSpaceProposal | null {
  const connection = activePartnerConnection(userId);
  const cleanContent = cleanSharedMemoryContent(content);
  if (!connection || !validSharedMemoryCategory(category) || !cleanContent) return null;
  const side = connectionMemberSide(connection, userId);
  if (!side) return null;
  const pending = db
    .prepare(
      `SELECT 1 FROM shared_memory_proposals
       WHERE connection_id = ? AND category = ? AND status = 'pending'`
    )
    .get(connection.id, category);
  if (pending) return null;
  const existing = db
    .prepare(
      `SELECT id FROM shared_memories
       WHERE connection_id = ? AND category = ? AND status = 'active'`
    )
    .get(connection.id, category) as { id: string } | undefined;
  const id = crypto.randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO shared_memory_proposals
      (id, connection_id, category, content, proposed_by_user_id, updated_by_user_id,
       replaces_memory_id, a_confirmed, b_confirmed, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    connection.id,
    category,
    cleanContent,
    userId,
    userId,
    existing?.id ?? null,
    side === "one" ? 1 : 0,
    side === "two" ? 1 : 0,
    timestamp,
    timestamp
  );
  return getSharedSpaceForUser(userId)?.proposals.find((proposal) => proposal.id === id) ?? null;
}

export function reviseSharedMemoryProposal(
  userId: string,
  proposalId: string,
  content: string
): boolean {
  const connection = activePartnerConnection(userId);
  const cleanContent = cleanSharedMemoryContent(content);
  if (!connection || !cleanContent) return false;
  const side = connectionMemberSide(connection, userId);
  if (!side) return false;
  return db
    .prepare(
      `UPDATE shared_memory_proposals
       SET content = ?, updated_by_user_id = ?, a_confirmed = ?, b_confirmed = ?,
           status = 'pending', rejected_by_user_id = NULL, rejection_reason = '', updated_at = ?,
           version = version + 1
       WHERE id = ? AND connection_id = ? AND proposed_by_user_id = ?
         AND status IN ('pending', 'rejected')`
    )
    .run(
      cleanContent,
      userId,
      side === "one" ? 1 : 0,
      side === "two" ? 1 : 0,
      now(),
      proposalId,
      connection.id,
      userId
    ).changes > 0;
}

export function confirmSharedMemoryProposal(userId: string, proposalId: string, expectedVersion: number): boolean {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return false;
  const connection = activePartnerConnection(userId);
  if (!connection) return false;
  const side = connectionMemberSide(connection, userId);
  if (!side) return false;
  return db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE shared_memory_proposals SET ${side === "one" ? "a_confirmed" : "b_confirmed"} = 1,
           updated_at = ? WHERE id = ? AND connection_id = ? AND status = 'pending' AND version = ?`
      )
      .run(now(), proposalId, connection.id, expectedVersion);
    if (updated.changes === 0) return false;
    const proposal = db
      .prepare(
        `SELECT category, content, a_confirmed, b_confirmed
         FROM shared_memory_proposals WHERE id = ? AND connection_id = ?`
      )
      .get(proposalId, connection.id) as
      | { category: string; content: string; a_confirmed: number; b_confirmed: number }
      | undefined;
    if (!proposal) return false;
    if (proposal.a_confirmed && proposal.b_confirmed) {
      if (!upsertConfirmedSharedMemory(connection.id, proposal.category, proposal.content)) return false;
      db.prepare(
        `UPDATE shared_memory_proposals SET status = 'accepted', updated_at = ?
         WHERE id = ? AND connection_id = ? AND status = 'pending'`
      ).run(now(), proposalId, connection.id);
    }
    return true;
  })();
}

export function rejectSharedMemoryProposal(
  userId: string,
  proposalId: string,
  reason = ""
): boolean {
  const connection = activePartnerConnection(userId);
  if (!connection || !connectionMemberSide(connection, userId)) return false;
  return db
    .prepare(
      `UPDATE shared_memory_proposals
       SET status = 'rejected', rejected_by_user_id = ?, rejection_reason = ?, updated_at = ?
       WHERE id = ? AND connection_id = ? AND status = 'pending'`
    )
    .run(userId, reason.trim().slice(0, 120), now(), proposalId, connection.id).changes > 0;
}

function unusedPartnerCode(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = randomCode(10);
    if (!db.prepare(`SELECT 1 FROM partner_invites WHERE code = ?`).get(code)) return code;
  }
  throw new Error("unable to create partner invite code");
}

function presentPartnerInvite(row: {
  id: string;
  code: string;
  status: PartnerInvite["status"];
  created_at: number;
  expires_at: number;
}): PartnerInvite {
  const status =
    (row.status === "pending" || row.status === "approval_pending") && row.expires_at <= now()
      ? "expired"
      : row.status;
  return {
    id: row.id,
    code: `${row.code.slice(0, 5)}-${row.code.slice(5)}`,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createPartnerInvite(userId: string, ttlMs = 7 * 24 * 60 * 60 * 1000): PartnerInvite | null {
  return db.transaction(() => {
    if (currentPartnerConnection(userId) || pendingPartnerBindingRequest(userId)) return null;
    const timestamp = now();
    db.prepare(`DELETE FROM partner_invites WHERE inviter_user_id = ?`).run(userId);
    const code = unusedPartnerCode();
    const row = {
      id: crypto.randomUUID(),
      code,
      status: "pending" as const,
      created_at: timestamp,
      expires_at: timestamp + ttlMs,
    };
    db.prepare(
      `INSERT INTO partner_invites
        (id, code, inviter_user_id, status, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ).run(row.id, row.code, userId, row.created_at, row.expires_at);
    return presentPartnerInvite(row);
  })();
}

export function getPartnerOverview(userId: string): PartnerOverview {
  const connection = currentPartnerConnection(userId);
  if (connection) {
    const partnerId = connection.user_one_id === userId ? connection.user_two_id : connection.user_one_id;
    const partner = getUserById(partnerId);
    return {
      connection: partner
        ? {
            id: connection.id,
            partner: publicPartner(partner),
            createdAt: connection.created_at,
            status:
              connection.status === "disconnecting"
                ? "disconnecting"
                : connection.paused_until && connection.paused_until > now()
                  ? "paused"
                  : "active",
            pausedUntil: connection.paused_until,
            pausedByMe: connection.paused_by_user_id === userId,
            disconnectEffectiveAt: connection.disconnect_effective_at,
            disconnectRequestedByMe: connection.disconnect_requested_by_user_id === userId,
          }
        : null,
      outgoingInvite: null,
      bindingRequest: null,
      archivedConnection: null,
    };
  }
  const binding = pendingPartnerBindingRequest(userId);
  if (binding) {
    const counterpartId = binding.inviter_user_id === userId
      ? binding.accepted_by_user_id
      : binding.inviter_user_id;
    const counterpart = counterpartId ? getUserById(counterpartId) : undefined;
    return {
      connection: null,
      outgoingInvite: null,
      bindingRequest: counterpart
        ? {
            id: binding.id,
            counterpart: publicPartner(counterpart),
            direction: binding.inviter_user_id === userId ? "incoming" : "outgoing",
            requestedAt: binding.accepted_at ?? binding.created_at,
            expiresAt: binding.expires_at,
          }
        : null,
      archivedConnection: latestArchivedConnection(userId),
    };
  }
  const invite = db
    .prepare(
      `SELECT id, code, status, created_at, expires_at FROM partner_invites
       WHERE inviter_user_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId) as
    | { id: string; code: string; status: PartnerInvite["status"]; created_at: number; expires_at: number }
    | undefined;
  return {
    connection: null,
    outgoingInvite: invite ? presentPartnerInvite(invite) : null,
    bindingRequest: null,
    archivedConnection: latestArchivedConnection(userId),
  };
}

export function revokePartnerInvite(userId: string, inviteId: string): boolean {
  return db.prepare(
    `UPDATE partner_invites SET status = 'revoked'
     WHERE id = ? AND inviter_user_id = ? AND status IN ('pending', 'approval_pending')`
  ).run(inviteId, userId).changes > 0;
}

type PartnerBindingRequestRow = {
  id: string;
  inviter_user_id: string;
  accepted_by_user_id: string | null;
  created_at: number;
  accepted_at: number | null;
  expires_at: number;
};

function pendingPartnerBindingRequest(userId: string): PartnerBindingRequestRow | undefined {
  return db.prepare(
    `SELECT id, inviter_user_id, accepted_by_user_id, created_at, accepted_at, expires_at
     FROM partner_invites
     WHERE status = 'approval_pending' AND expires_at > ?
       AND (inviter_user_id = ? OR accepted_by_user_id = ?)
     ORDER BY accepted_at DESC LIMIT 1`
  ).get(now(), userId, userId) as PartnerBindingRequestRow | undefined;
}

function requestPartnerBindingForUser(code: string, acceptingUserId: string): boolean {
  const normalized = normalizeRegistrationCode(code);
  const timestamp = now();
  const invite = db.prepare(
    `SELECT id, inviter_user_id FROM partner_invites
     WHERE code = ? AND status = 'pending' AND expires_at > ?`
  ).get(normalized, timestamp) as { id: string; inviter_user_id: string } | undefined;
  if (!invite || invite.inviter_user_id === acceptingUserId) return false;
  if (
    currentPartnerConnection(invite.inviter_user_id) ||
    currentPartnerConnection(acceptingUserId) ||
    pendingPartnerBindingRequest(acceptingUserId)
  ) return false;
  const requested = db.prepare(
    `UPDATE partner_invites SET status = 'approval_pending', accepted_by_user_id = ?, accepted_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(acceptingUserId, timestamp, invite.id);
  return requested.changes > 0;
}

export function acceptPartnerInvite(code: string, acceptingUserId: string): boolean {
  return db.transaction(() => requestPartnerBindingForUser(code, acceptingUserId))();
}

export function approvePartnerBindingRequest(userId: string, inviteId: string): boolean {
  return db.transaction(() => {
    const request = db.prepare(
      `SELECT id, inviter_user_id, accepted_by_user_id FROM partner_invites
       WHERE id = ? AND inviter_user_id = ? AND status = 'approval_pending' AND expires_at > ?`
    ).get(inviteId, userId, now()) as
      | { id: string; inviter_user_id: string; accepted_by_user_id: string | null }
      | undefined;
    if (!request?.accepted_by_user_id) return false;
    if (currentPartnerConnection(userId) || currentPartnerConnection(request.accepted_by_user_id)) return false;
    const timestamp = now();
    db.prepare(
      `INSERT INTO partner_connections (id, user_one_id, user_two_id, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`
    ).run(crypto.randomUUID(), userId, request.accepted_by_user_id, timestamp);
    const accepted = db.prepare(
      `UPDATE partner_invites SET status = 'accepted'
       WHERE id = ? AND inviter_user_id = ? AND status = 'approval_pending'`
    ).run(inviteId, userId);
    if (!accepted.changes) return false;
    db.prepare(
      `UPDATE partner_invites SET status = 'revoked'
       WHERE status IN ('pending', 'approval_pending')
         AND id <> ? AND (inviter_user_id IN (?, ?) OR accepted_by_user_id IN (?, ?))`
    ).run(inviteId, userId, request.accepted_by_user_id, userId, request.accepted_by_user_id);
    return true;
  })();
}

export function cancelPartnerBindingRequest(userId: string, inviteId: string): boolean {
  return db.prepare(
    `UPDATE partner_invites SET status = 'revoked'
     WHERE id = ? AND status = 'approval_pending'
       AND (inviter_user_id = ? OR accepted_by_user_id = ?)`
  ).run(inviteId, userId, userId).changes > 0;
}

export function createUserWithPartnerInvite(
  code: string,
  email: string,
  displayName: string,
  passwordHash: string,
  passwordSalt: string
): UserRow | null {
  return db.transaction(() => {
    const normalized = normalizeRegistrationCode(code);
    const invite = db.prepare(
      `SELECT inviter_user_id FROM partner_invites
       WHERE code = ? AND status = 'pending' AND expires_at > ?`
    ).get(normalized, now()) as { inviter_user_id: string } | undefined;
    if (!invite || currentPartnerConnection(invite.inviter_user_id)) return null;
    const user = createUser(email, displayName, passwordHash, passwordSalt, false);
    if (!requestPartnerBindingForUser(code, user.id)) throw new Error("partner invite changed");
    return user;
  })();
}

export function pausePartnerConnection(userId: string, days: 1 | 3 | 7): boolean {
  const connection = currentPartnerConnection(userId);
  if (!connection || connection.status !== "active") return false;
  return db.prepare(
    `UPDATE partner_connections
     SET paused_until = ?, paused_by_user_id = ?
     WHERE id = ? AND status = 'active'`
  ).run(now() + days * 24 * 60 * 60 * 1000, userId, connection.id).changes > 0;
}

export function resumePartnerConnection(userId: string): boolean {
  const connection = currentPartnerConnection(userId);
  if (!connection || connection.status !== "active" || connection.paused_by_user_id !== userId) return false;
  return db.prepare(
    `UPDATE partner_connections SET paused_until = NULL, paused_by_user_id = NULL
     WHERE id = ? AND status = 'active'`
  ).run(connection.id).changes > 0;
}

export function requestPartnerDisconnect(userId: string): boolean {
  const connection = currentPartnerConnection(userId);
  if (!connection || connection.status !== "active") return false;
  const timestamp = now();
  return db.transaction(() => {
    const updated = db.prepare(
      `UPDATE partner_connections
       SET status = 'disconnecting', disconnect_requested_at = ?, disconnect_effective_at = ?,
           disconnect_requested_by_user_id = ?, paused_until = NULL, paused_by_user_id = NULL
       WHERE id = ? AND status = 'active'`
    ).run(timestamp, timestamp + PARTNER_DISCONNECT_GRACE_MS, userId, connection.id);
    if (!updated.changes) return false;
    db.prepare(
      `UPDATE events SET state = 'cancelled', partner_target_user_id = NULL
       WHERE state = 'waiting_b'
         AND ((a_user_id = ? AND partner_target_user_id = ?)
           OR (a_user_id = ? AND partner_target_user_id = ?))`
    ).run(
      connection.user_one_id,
      connection.user_two_id,
      connection.user_two_id,
      connection.user_one_id
    );
    return true;
  })();
}

export function cancelPartnerDisconnect(userId: string): boolean {
  const connection = currentPartnerConnection(userId);
  if (!connection || connection.status !== "disconnecting") return false;
  if (connection.disconnect_requested_by_user_id !== userId) return false;
  return db.prepare(
    `UPDATE partner_connections
     SET status = 'active', disconnect_requested_at = NULL, disconnect_effective_at = NULL,
         disconnect_requested_by_user_id = NULL
     WHERE id = ? AND status = 'disconnecting'`
  ).run(connection.id).changes > 0;
}

function latestArchivedConnection(userId: string): ArchivedPartnerConnection | null {
  finalizeDuePartnerConnections();
  const connection = db.prepare(
    `SELECT * FROM partner_connections
     WHERE status = 'ended' AND ended_at IS NOT NULL AND (user_one_id = ? OR user_two_id = ?)
     ORDER BY ended_at DESC LIMIT 1`
  ).get(userId, userId) as PartnerConnectionRow | undefined;
  if (!connection?.ended_at) return null;
  const partnerId = connection.user_one_id === userId ? connection.user_two_id : connection.user_one_id;
  const partner = getUserById(partnerId);
  if (!partner) return null;
  const memories = db.prepare(
    `SELECT id, category, content, created_at, updated_at, version
     FROM shared_memories WHERE connection_id = ? AND status = 'archived'
     ORDER BY updated_at DESC`
  ).all(connection.id) as Array<{
    id: string; category: string; content: string; created_at: number; updated_at: number; version: number;
  }>;
  return {
    id: connection.id,
    partner: publicPartner(partner),
    endedAt: connection.ended_at,
    recoverableUntil: connection.ended_at + PARTNER_RECOVERY_WINDOW_MS,
    recoveryRequestedByMe: connection.recovery_requested_by_user_id === userId,
    recoveryRequestedByPartner:
      !!connection.recovery_requested_by_user_id && connection.recovery_requested_by_user_id !== userId,
    restoreMemories: !!connection.recovery_restore_memories,
    memories: memories.filter((memory) => validSharedMemoryCategory(memory.category)).map((memory) => ({
      id: memory.id,
      category: memory.category as SharedMemoryCategory,
      content: memory.content,
      createdAt: memory.created_at,
      updatedAt: memory.updated_at,
      version: memory.version,
    })),
  };
}

export function requestPartnerRecovery(userId: string, connectionId: string, restoreMemories: boolean): boolean {
  finalizeDuePartnerConnections();
  if (currentPartnerConnection(userId)) return false;
  const connection = db.prepare(
    `SELECT * FROM partner_connections
     WHERE id = ? AND status = 'ended' AND ended_at > ?
       AND (user_one_id = ? OR user_two_id = ?)`
  ).get(connectionId, now() - PARTNER_RECOVERY_WINDOW_MS, userId, userId) as PartnerConnectionRow | undefined;
  if (!connection) return false;
  const partnerId = connection.user_one_id === userId ? connection.user_two_id : connection.user_one_id;
  if (currentPartnerConnection(partnerId)) return false;
  return db.prepare(
    `UPDATE partner_connections
     SET recovery_requested_at = ?, recovery_requested_by_user_id = ?, recovery_restore_memories = ?
     WHERE id = ? AND status = 'ended'`
  ).run(now(), userId, restoreMemories ? 1 : 0, connection.id).changes > 0;
}

export function approvePartnerRecovery(userId: string, connectionId: string): boolean {
  return db.transaction(() => {
    finalizeDuePartnerConnections();
    if (currentPartnerConnection(userId)) return false;
    const connection = db.prepare(
      `SELECT * FROM partner_connections
       WHERE id = ? AND status = 'ended' AND ended_at > ?
         AND recovery_requested_by_user_id IS NOT NULL
         AND recovery_requested_by_user_id <> ?
         AND (user_one_id = ? OR user_two_id = ?)`
    ).get(connectionId, now() - PARTNER_RECOVERY_WINDOW_MS, userId, userId, userId) as PartnerConnectionRow | undefined;
    if (!connection) return false;
    const requester = connection.recovery_requested_by_user_id!;
    if (currentPartnerConnection(requester)) return false;
    const updated = db.prepare(
      `UPDATE partner_connections
       SET status = 'active', created_at = ?, ended_at = NULL, ended_by_user_id = NULL,
           disconnect_requested_at = NULL, disconnect_effective_at = NULL,
           disconnect_requested_by_user_id = NULL, recovery_requested_at = NULL,
           recovery_requested_by_user_id = NULL, recovery_restore_memories = 0
       WHERE id = ? AND status = 'ended'`
    ).run(now(), connection.id);
    if (!updated.changes) return false;
    if (connection.recovery_restore_memories) {
      db.prepare(
        `UPDATE shared_memories SET status = 'active', updated_at = ?
         WHERE connection_id = ? AND status = 'archived'`
      ).run(now(), connection.id);
    }
    return true;
  })();
}

export function createAccountSession(
  userId: string,
  tokenHash: string,
  expiresAt: number
): void {
  db.prepare(
    `INSERT INTO account_sessions (token_hash, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(tokenHash, userId, expiresAt, now());
}

export function getUserBySessionTokenHash(tokenHash: string): UserRow | undefined {
  const timestamp = now();
  db.prepare(`DELETE FROM account_sessions WHERE expires_at <= ?`).run(timestamp);
  return db
    .prepare(
      `SELECT users.* FROM account_sessions
       JOIN users ON users.id = account_sessions.user_id
       WHERE account_sessions.token_hash = ? AND account_sessions.expires_at > ?`
    )
    .get(tokenHash, timestamp) as UserRow | undefined;
}

export function deleteAccountSession(tokenHash: string): void {
  db.prepare(`DELETE FROM account_sessions WHERE token_hash = ?`).run(tokenHash);
}

export function deleteAllAccountSessions(userId: string): void {
  db.prepare(`DELETE FROM account_sessions WHERE user_id = ?`).run(userId);
}

export function updateUserPassword(userId: string, passwordHash: string, passwordSalt: string): boolean {
  const result = db
    .prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`)
    .run(passwordHash, passwordSalt, userId);
  if (result.changes > 0) deleteAllAccountSessions(userId);
  return result.changes > 0;
}

export function listUsersForAdmin(): PublicUser[] {
  return (db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all() as UserRow[]).map(publicUser);
}

function resetCodeHash(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()).digest("hex");
}

export function createPasswordResetCode(
  userId: string,
  createdByUserId: string,
  ttlMs = 30 * 60 * 1000
): { code: string; expiresAt: number } | null {
  if (!getUserById(userId)) return null;
  const code = randomCode(10);
  const createdAt = now();
  db.prepare(
    `UPDATE password_reset_codes SET used_at = ?
     WHERE user_id = ? AND used_at IS NULL`
  ).run(createdAt, userId);
  db.prepare(
    `INSERT INTO password_reset_codes
      (id, code_hash, user_id, created_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), resetCodeHash(code), userId, createdByUserId, createdAt, createdAt + ttlMs);
  return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt: createdAt + ttlMs };
}

export function resetPasswordWithCode(
  email: string,
  code: string,
  passwordHash: string,
  passwordSalt: string
): boolean {
  return db.transaction(() => {
    const user = getUserByEmail(email);
    if (!user) return false;
    const timestamp = now();
    const reset = db
      .prepare(
        `SELECT id FROM password_reset_codes
         WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`
      )
      .get(user.id, resetCodeHash(code), timestamp) as { id: string } | undefined;
    if (!reset) return false;
    db.prepare(`UPDATE password_reset_codes SET used_at = ? WHERE id = ?`).run(timestamp, reset.id);
    return updateUserPassword(user.id, passwordHash, passwordSalt);
  })();
}

export function listEventsForUser(userId: string): UserEventSummary[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.state, e.created_at,
        CASE WHEN e.b_user_id IS NOT NULL OR e.b_token IS NOT NULL THEN 1 ELSE 0 END AS has_partner,
        CASE WHEN e.a_user_id = ? THEN 'a' ELSE 'b' END AS role,
        CASE WHEN e.a_user_id = ? THEN COALESCE(d.a_confirmed, 0) ELSE COALESCE(d.b_confirmed, 0) END AS my_delete,
        CASE WHEN e.a_user_id = ? THEN COALESCE(d.b_confirmed, 0) ELSE COALESCE(d.a_confirmed, 0) END AS partner_delete
       FROM events e
       LEFT JOIN event_user_visibility visibility
         ON visibility.event_id = e.id AND visibility.user_id = ?
       LEFT JOIN event_deletion_requests d ON d.event_id = e.id AND d.status = 'pending'
       WHERE (e.a_user_id = ? OR e.b_user_id = ?) AND visibility.event_id IS NULL
       ORDER BY e.created_at DESC`
    )
    .all(userId, userId, userId, userId, userId, userId) as {
      id: string;
      title: string;
      state: EventState;
      role: "a" | "b";
      has_partner: number;
      created_at: number;
      my_delete: number;
      partner_delete: number;
    }[];
  return rows.map((row) => ({
    id: row.id,
    title: row.state === "sharing_revoked" ? "分享已停止" : row.title,
    state: row.state,
    role: row.role,
    hasPartner: !!row.has_partner,
    createdAt: row.created_at,
    deletionRequestedByMe: !!row.my_delete,
    deletionRequestedByPartner: !!row.partner_delete,
  }));
}

export function listPartnerEventInvites(userId: string, createdAfter: number): PartnerEventInvite[] {
  if (!activePartnerConnection(userId)) return [];
  const rows = db.prepare(
    `SELECT e.id, e.title, e.created_at, e.invite_created_at,
            u.display_name AS inviter_name,
            CASE WHEN snooze.event_id IS NULL THEN 0 ELSE 1 END AS snoozed
     FROM events e
     JOIN users u ON u.id = e.a_user_id
     LEFT JOIN partner_event_invite_snoozes snooze
       ON snooze.event_id = e.id AND snooze.user_id = ?
     WHERE e.partner_target_user_id = ? AND e.state = 'waiting_b'
       AND COALESCE(e.invite_created_at, e.created_at) > ?
     ORDER BY e.created_at DESC`
  ).all(userId, userId, createdAfter) as {
    id: string; title: string; created_at: number; invite_created_at: number | null;
    inviter_name: string; snoozed: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    inviterName: row.inviter_name,
    createdAt: row.created_at,
    expiresAt: (row.invite_created_at ?? row.created_at) + 7 * 24 * 60 * 60 * 1000,
    snoozed: !!row.snoozed,
  }));
}

export function snoozePartnerEventInvite(eventId: string, userId: string): boolean {
  const event = db.prepare(
    `SELECT 1 FROM events
     WHERE id = ? AND partner_target_user_id = ? AND state = 'waiting_b'`
  ).get(eventId, userId);
  if (!event) return false;
  db.prepare(
    `INSERT INTO partner_event_invite_snoozes (event_id, user_id, snoozed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET snoozed_at = excluded.snoozed_at`
  ).run(eventId, userId, now());
  return true;
}

export function declinePartnerEventInvite(eventId:string,userId:string):boolean {
  return db.prepare(`UPDATE events SET state='declined',partner_target_user_id=NULL WHERE id=? AND partner_target_user_id=? AND state='waiting_b'`).run(eventId,userId).changes>0;
}

export function targetActivePartnerForEvent(eventId: string, inviterUserId: string): string | null {
  const partnerUserId = getActivePartnerUserId(inviterUserId);
  if (!partnerUserId) return null;
  const result = db.prepare(
    `UPDATE events SET partner_target_user_id = ?, invite_mode = 'partner_direct', invite_created_at = ?
     WHERE id = ? AND a_user_id = ? AND state = 'waiting_b'`
  ).run(partnerUserId, now(), eventId, inviterUserId);
  return result.changes > 0 ? partnerUserId : null;
}

export function acceptPartnerEventInvite(eventId: string, userId: string): string | null {
  const event = getEvent(eventId);
  if (!event?.a_user_id || getActivePartnerUserId(event.a_user_id) !== userId) return null;
  const token = randomToken();
  const result = db.prepare(
    `UPDATE events
     SET b_user_id = ?, b_token = ?, partner_target_user_id = NULL, state = 'b_guiding'
     WHERE id = ? AND partner_target_user_id = ? AND state = 'waiting_b'
       AND b_user_id IS NULL AND b_token IS NULL`
  ).run(userId, token, eventId, userId);
  return result.changes > 0 ? token : null;
}

export function getPartnerTarget(eventId: string): PartnerUser | null {
  const event = getEvent(eventId);
  if (!event?.partner_target_user_id) return null;
  const user = getUserById(event.partner_target_user_id);
  return user ? publicPartner(user) : null;
}

export function clearPartnerTargetForEvent(eventId: string): void {
  db.prepare(`UPDATE events SET partner_target_user_id = NULL WHERE id = ?`).run(eventId);
}

export function renameEvent(eventId: string, userId: string, title: string): boolean {
  return db
    .prepare(`UPDATE events SET title = ? WHERE id = ? AND (a_user_id = ? OR b_user_id = ?)`)
    .run(title, eventId, userId, userId).changes > 0;
}

export function exportUserData(userId: string): Record<string, unknown> {
  const user = getUserById(userId);
  if (!user) return {};
  const events = db
    .prepare(`SELECT * FROM events WHERE a_user_id = ? OR b_user_id = ? ORDER BY created_at`)
    .all(userId, userId) as EventRow[];
  return {
    exportedAt: new Date(now()).toISOString(),
    account: publicUser(user),
    communicationPreferences: listPersonalPreferences(userId).map((preference) => ({
      category: preference.category,
      description: PERSONAL_PREFERENCE_DESCRIPTIONS[preference.setting],
      confidence: preference.confidence,
      updatedAt: preference.updated_at,
    })),
    sharedSpace: listSharedMemoriesForUser(userId).map((memory) => ({
      category: memory.category,
      content: memory.content,
      confirmedAt: memory.updated_at,
    })),
    privateConversations: (db.prepare(`SELECT id,title,version,created_at,updated_at,last_message_at FROM private_conversations WHERE owner_user_id=? AND status='active' ORDER BY created_at`).all(userId) as {id:string;title:string;version:number;created_at:number;updated_at:number;last_message_at:number|null}[]).map((conversation)=>({
      ...conversation,
      messages: db.prepare(`SELECT role,content,version,status,created_at FROM private_messages WHERE conversation_id=? ORDER BY created_at,rowid`).all(conversation.id),
      notes: db.prepare(`SELECT kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,correction,updated_at FROM private_notes WHERE conversation_id=?`).all(conversation.id),
      shareDrafts: db.prepare(`SELECT content,source_message_ids,version,status,created_at,updated_at,event_id FROM private_share_drafts WHERE conversation_id=?`).all(conversation.id),
    })),
    conversations: events.map((event) => {
      const side: GuideSide = event.a_user_id === userId ? "a" : "b";
      const perspective = getPerspective(event.id, side);
      const shared = event.state === "sharing_revoked" ? undefined : db.prepare(`SELECT content FROM merged WHERE event_id = ?`).get(event.id) as
        | { content: string | null }
        | undefined;
      const agreement = event.state === "sharing_revoked" ? undefined : db.prepare(
        `SELECT choices, done, due_at, a_review, b_review FROM agreements WHERE event_id = ?`
      ).get(event.id) as
        | { choices: string | null; done: number; due_at: number | null; a_review: string | null; b_review: string | null }
        | undefined;
      return {
        id: event.id,
        title: event.state === "sharing_revoked" ? "分享已停止" : event.title,
        state: event.state,
        role: side === "a" ? "我发起的" : "我加入的",
        createdAt: event.created_at,
        privateMessages: getGuideMessages(event.id, side),
        mySummary: perspective?.summary ? JSON.parse(perspective.summary) : null,
        sharedUnderstanding: shared?.content
          ? scopeMergedForRole(JSON.parse(shared.content) as MergedUnderstanding, side)
          : null,
        agreement: agreement
          ? {
              choices: agreement.choices ? JSON.parse(agreement.choices) : null,
              done: !!agreement.done,
              dueAt: agreement.due_at,
              myReview:
                side === "a"
                  ? agreement.a_review
                    ? JSON.parse(agreement.a_review)
                    : null
                  : agreement.b_review
                    ? JSON.parse(agreement.b_review)
                    : null,
            }
          : null,
      };
    }),
  };
}

// 注销只删除本人的私密内容；对方私密内容和双方已经确认的共同结果均保留。
// 共同结果需要双方另行确认才能永久删除。
export function deleteUserPrivateData(userId: string): boolean {
  return db.transaction(() => {
    const user = getUserById(userId);
    if (!user) return false;
    if (process.env.DEEPWE_OWNER_USER_ID?.trim() === userId) return false;

    const privateConversationIds = db.prepare(`SELECT id FROM private_conversations WHERE owner_user_id=?`).all(userId) as {id:string}[];
    for(const {id} of privateConversationIds) {
      db.prepare(`UPDATE events SET a_conversation_id=NULL WHERE a_conversation_id=?`).run(id);
      db.prepare(`UPDATE events SET b_conversation_id=NULL WHERE b_conversation_id=?`).run(id);
      db.prepare(`DELETE FROM private_jobs WHERE conversation_id=?`).run(id);
      db.prepare(`DELETE FROM private_reply_feedback WHERE conversation_id=?`).run(id);
      db.prepare(`DELETE FROM private_risk_state WHERE conversation_id=?`).run(id);
      db.prepare(`DELETE FROM private_messages WHERE conversation_id=?`).run(id);
      db.prepare(`DELETE FROM private_notes WHERE conversation_id=?`).run(id);
      db.prepare(`DELETE FROM private_share_drafts WHERE conversation_id=?`).run(id);
    }
    db.prepare(`DELETE FROM private_conversations WHERE owner_user_id=?`).run(userId);
    db.prepare(`DELETE FROM private_memory_items WHERE owner_user_id=?`).run(userId);
    db.prepare(`DELETE FROM private_memory_tombstones WHERE owner_user_id=?`).run(userId);
    db.prepare(`DELETE FROM private_memory_cutoff_sources WHERE owner_user_id=?`).run(userId);
    db.prepare(`DELETE FROM private_memory_settings WHERE owner_user_id=?`).run(userId);
    db.prepare(`DELETE FROM private_reply_feedback WHERE owner_user_id=?`).run(userId);
    db.prepare(`DELETE FROM analytics_events WHERE user_id=?`).run(userId);
    db.prepare(`DELETE FROM ai_call_metrics WHERE analytics_user_id=? OR analytics_event_id IN (SELECT id FROM events WHERE a_user_id=? OR b_user_id=?)`).run(userId,userId,userId);

    const events = db
      .prepare(`SELECT * FROM events WHERE a_user_id = ? OR b_user_id = ?`)
      .all(userId, userId) as EventRow[];
    for (const event of events) {
      const side: GuideSide = event.a_user_id === userId ? "a" : "b";
      const otherUserId = side === "a" ? event.b_user_id : event.a_user_id;
      if (!otherUserId) {
        deleteEventCompletely(event.id);
        continue;
      }

      db.prepare(`DELETE FROM ai_jobs WHERE event_id = ?`).run(event.id);
      db.prepare(`DELETE FROM guide_sessions WHERE event_id = ? AND side = ?`).run(event.id, side);
      db.prepare(`DELETE FROM guide_messages WHERE event_id = ? AND side = ?`).run(event.id, side);
      db.prepare(`DELETE FROM message_feedback WHERE event_id = ? AND side = ?`).run(event.id, side);
      db.prepare(`DELETE FROM perspectives WHERE event_id = ? AND role = ?`).run(event.id, side);
      if (side === "a") {
        db.prepare(`UPDATE events SET a_user_id = NULL, a_token = ? WHERE id = ?`)
          .run(randomToken(), event.id);
      } else {
        db.prepare(`UPDATE events SET b_user_id = NULL, b_token = NULL WHERE id = ?`)
          .run(event.id);
      }
    }

    db.prepare(
      `UPDATE partner_connections
       SET status = 'ended', ended_at = ?, ended_by_user_id = ?
       WHERE status IN ('active', 'disconnecting') AND (user_one_id = ? OR user_two_id = ?)`
    ).run(now(), userId, userId, userId);
    db.prepare(
      `UPDATE shared_memories SET status = 'archived', updated_at = ?
       WHERE connection_id IN (
         SELECT id FROM partner_connections WHERE user_one_id = ? OR user_two_id = ?
       ) AND status = 'active'`
    ).run(now(), userId, userId);
    db.prepare(
      `UPDATE partner_invites SET status = 'revoked'
       WHERE inviter_user_id = ? AND status = 'pending'`
    ).run(userId);
    db.prepare(
      `UPDATE partner_invites SET accepted_by_user_id = NULL
       WHERE accepted_by_user_id = ?`
    ).run(userId);
    db.prepare(
      `UPDATE events SET state = 'cancelled', partner_target_user_id = NULL
       WHERE partner_target_user_id = ? AND state = 'waiting_b'`
    ).run(userId);

    db.prepare(`DELETE FROM password_reset_codes WHERE user_id = ? OR created_by_user_id = ?`).run(userId, userId);
    db.prepare(`DELETE FROM registration_invites WHERE created_by_user_id = ? AND status = 'unused'`).run(userId);
    db.prepare(`UPDATE registration_invites SET used_by_user_id = NULL WHERE used_by_user_id = ?`).run(userId);
    db.prepare(`DELETE FROM personal_preferences WHERE user_id = ?`).run(userId);
    deleteAllAccountSessions(userId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    return true;
  })();
}

export function claimLegacyEvent(eventId: string, userId: string, token: string): "a" | "b" | null {
  const event = getEvent(eventId);
  if (!event) return null;
  if (!event.a_user_id && token === event.a_token) {
    const result = db
      .prepare(`UPDATE events SET a_user_id = ? WHERE id = ? AND a_user_id IS NULL`)
      .run(userId, eventId);
    return result.changes > 0 ? "a" : null;
  }
  if (!event.b_user_id && event.b_token && token === event.b_token) {
    const result = db
      .prepare(`UPDATE events SET b_user_id = ? WHERE id = ? AND b_user_id IS NULL`)
      .run(userId, eventId);
    return result.changes > 0 ? "b" : null;
  }
  return null;
}

// ---------- events ----------

export function createEvent(
  title: string,
  aUserId: string | null = null
): { id: string; code: string; aToken: string } {
  const id = crypto.randomUUID();
  const code = createUnusedEventCode();
  const aToken = randomToken();
  const timestamp = now();
  db.prepare(
    `INSERT INTO events
      (id, title, code, state, a_token, a_user_id, risk_level, created_at, invite_created_at, invite_mode)
     VALUES (?, ?, ?, 'a_guiding', ?, ?, 'none', ?, ?, 'partner_direct')`
  ).run(id, title, code, aToken, aUserId, timestamp, timestamp);
  return { id, code, aToken };
}

export function getEvent(id: string): EventRow | undefined {
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow | undefined;
}

export function getEventByCode(code: string): EventRow | undefined {
  return db.prepare(`SELECT * FROM events WHERE code = ?`).get(code.toUpperCase()) as
    | EventRow
    | undefined;
}

// 严格状态转换表：每个状态只允许进入列出的下一个状态。
// 任何动作只能走这条表，重复/越权/乱序请求会被拒绝。
const TRANSITIONS: Record<EventState, EventState[]> = {
  a_guiding: ["a_summary", "closed", "safety_exit"],
  a_expressing: ["a_summary", "safety_exit"],
  a_summary: ["waiting_b"],
  waiting_b: ["b_guiding", "b_expressing", "declined", "cancelled"],
  b_guiding: ["b_summary", "closed", "safety_exit", "declined"],
  b_expressing: ["b_summary", "safety_exit", "declined"],
  b_summary: ["merged", "declined"],
  ready_to_merge: ["merged"],
  merged: ["merged", "agreement_proposed"],
  agreement_proposed: ["done"],
  done: ["completed"],
  completed: [],
  declined: [],
  cancelled: ["a_guiding", "waiting_b"],
  sharing_revoked: [],
  closed: [],
  safety_exit: [],
};

// 原子状态转换：只有当事件当前状态恰好是 from 时才更新为 to。
// 返回是否成功，防止重复请求或并发覆盖。
export function transition(id: string, from: EventState, to: EventState): boolean {
  if (!TRANSITIONS[from]?.includes(to)) return false;
  const res = db
    .prepare(`UPDATE events SET state = ? WHERE id = ? AND state = ?`)
    .run(to, id, from);
  return res.changes > 0;
}

function createUnusedEventCode(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = randomCode(10);
    const exists = db.prepare(`SELECT 1 FROM events WHERE code = ?`).get(code);
    if (!exists) return code;
  }
  throw new Error("unable to create a unique event invite code");
}

// 撤回只终止本次邀请。继续聊时保留全部私密消息和故事地图，
// 但撤销旧摘要确认，避免补充内容后仍误用旧版表达。
export function reopenCancelledToGuiding(eventId: string): boolean {
  return db.transaction(() => {
    const result = db
      .prepare(`UPDATE events SET state = 'a_guiding' WHERE id = ? AND state = 'cancelled'`)
      .run(eventId);
    if (result.changes === 0) return false;
    db.prepare(
      `UPDATE perspectives
       SET summary = NULL, summary_confirmed = 0, correction = NULL
       WHERE event_id = ? AND role = 'a'`
    ).run(eventId);
    db.prepare(
      `UPDATE guide_sessions
       SET stage = 'checkin', story_confirmed = 0, updated_at = ?
       WHERE event_id = ? AND side = 'a'`
    ).run(now(), eventId);
    db.prepare(
      `UPDATE ai_jobs SET status = 'cancelled', error = NULL, updated_at = ?
       WHERE event_id = ? AND status IN ('queued', 'processing', 'failed')`
    ).run(now(), eventId);
    return true;
  })();
}

// 不修改已经确认的表达，直接重新提交时必须换一枚全新邀请码，
// 保证被撤回的旧码永远不会重新生效。
export function resubmitCancelledInvite(eventId: string): string | null {
  return db.transaction(() => {
    const prepared = db
      .prepare(
        `SELECT 1
         FROM events e
         JOIN perspectives p ON p.event_id = e.id AND p.role = 'a'
         WHERE e.id = ? AND e.state = 'cancelled'
           AND p.summary IS NOT NULL AND p.summary_confirmed = 1`
      )
      .get(eventId);
    if (!prepared) return null;
    const code = createUnusedEventCode();
    const result = db
      .prepare(
        `UPDATE events
         SET state = 'waiting_b', code = ?, invite_created_at = ?,
             b_token = NULL, b_user_id = NULL, partner_target_user_id = NULL
         WHERE id = ? AND state = 'cancelled'`
      )
      .run(code, now(), eventId);
    return result.changes > 0 ? code : null;
  })();
}

export function refreshExpiredInvite(eventId: string, expiredBefore: number): string | null {
  return db.transaction(() => {
    const code = createUnusedEventCode();
    const result = db
      .prepare(
        `UPDATE events
         SET code = ?, invite_created_at = ?
         WHERE id = ? AND state = 'waiting_b'
           AND b_token IS NULL AND b_user_id IS NULL
           AND COALESCE(invite_created_at, created_at) <= ?
           AND EXISTS (
             SELECT 1 FROM perspectives p
             WHERE p.event_id = events.id AND p.role = 'a'
               AND p.summary IS NOT NULL AND p.summary_confirmed = 1
           )`
      )
      .run(code, now(), eventId, expiredBefore);
    return result.changes > 0 ? code : null;
  })();
}

export function setBTokens(id: string, bToken: string): void {
  db.prepare(`UPDATE events SET b_token = ? WHERE id = ?`).run(bToken, id);
}

export function setBParticipant(id: string, bToken: string, bUserId: string): boolean {
  const result = db
    .prepare(
      `UPDATE events SET b_token = ?, b_user_id = ?, partner_target_user_id = NULL
       WHERE id = ? AND state = 'waiting_b' AND b_token IS NULL AND b_user_id IS NULL`
    )
    .run(bToken, bUserId, id);
  return result.changes > 0;
}

export function setRisk(id: string, riskLevel: string, side?: GuideSide): void {
  db.transaction(() => {
    db.prepare(`UPDATE events SET risk_level = ?, risk_side = ? WHERE id = ?`).run(riskLevel, riskLevel === "none" ? null : side ?? null, id);
    if (riskLevel !== "none") {
      db.prepare(`UPDATE ai_jobs SET status='cancelled',error=NULL,updated_at=?
        WHERE event_id=? AND status IN ('queued','processing','failed')`).run(now(), id);
    }
  })();
}

export function hideEventForUser(eventId: string, userId: string): boolean {
  const event = getEvent(eventId);
  if (!event || (event.a_user_id !== userId && event.b_user_id !== userId)) return false;
  db.prepare(
    `INSERT INTO event_user_visibility (event_id, user_id, hidden_at)
     VALUES (?, ?, ?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET hidden_at = excluded.hidden_at`
  ).run(eventId, userId, now());
  return true;
}

export function clearOwnPrivateEventData(eventId: string, userId: string): boolean {
  const event = getEvent(eventId);
  if (!event) return false;
  const side: GuideSide | null = event.a_user_id === userId ? "a" : event.b_user_id === userId ? "b" : null;
  if (!side) return false;
  return db.transaction(() => {
    db.prepare(`DELETE FROM ai_jobs WHERE event_id = ? AND side = ?`).run(eventId, side);
    db.prepare(`DELETE FROM guide_sessions WHERE event_id = ? AND side = ?`).run(eventId, side);
    db.prepare(`DELETE FROM guide_messages WHERE event_id = ? AND side = ?`).run(eventId, side);
    db.prepare(`DELETE FROM message_feedback WHERE event_id = ? AND side = ?`).run(eventId, side);
    db.prepare(`UPDATE perspectives SET raw_text = '' WHERE event_id = ? AND role = ?`).run(eventId, side);
    return true;
  })();
}

export function requestEventDeletion(
  eventId: string,
  userId: string
): "pending" | "deleted" | null {
  const event = getEvent(eventId);
  if (!event) return null;
  const side: GuideSide | null = event.a_user_id === userId ? "a" : event.b_user_id === userId ? "b" : null;
  if (!side) return null;
  const otherUserId = side === "a" ? event.b_user_id : event.a_user_id;
  if (!otherUserId) return deleteEventCompletely(eventId) ? "deleted" : null;
  return db.transaction(() => {
    const timestamp = now();
    db.prepare(
      `INSERT INTO event_deletion_requests
        (event_id, requested_by_user_id, a_confirmed, b_confirmed, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         a_confirmed = MAX(a_confirmed, excluded.a_confirmed),
         b_confirmed = MAX(b_confirmed, excluded.b_confirmed),
         updated_at = excluded.updated_at`
    ).run(eventId, userId, side === "a" ? 1 : 0, side === "b" ? 1 : 0, timestamp, timestamp);
    const request = db.prepare(
      `SELECT a_confirmed, b_confirmed FROM event_deletion_requests
       WHERE event_id = ? AND status = 'pending'`
    ).get(eventId) as { a_confirmed: number; b_confirmed: number };
    if (request.a_confirmed && request.b_confirmed) {
      deleteEventCompletely(eventId);
      return "deleted" as const;
    }
    return "pending" as const;
  })();
}

export function cancelEventDeletionRequest(eventId: string, userId: string): boolean {
  const event = getEvent(eventId);
  if (!event) return false;
  const side: GuideSide | null = event.a_user_id === userId ? "a" : event.b_user_id === userId ? "b" : null;
  if (!side) return false;
  return db.transaction(() => {
    const result = db.prepare(
      `UPDATE event_deletion_requests
       SET ${side === "a" ? "a_confirmed" : "b_confirmed"} = 0, updated_at = ?
       WHERE event_id = ? AND status = 'pending'`
    ).run(now(), eventId);
    db.prepare(
      `DELETE FROM event_deletion_requests
       WHERE event_id = ? AND a_confirmed = 0 AND b_confirmed = 0`
    ).run(eventId);
    return result.changes > 0;
  })();
}

// 永久删除一次潜谈及其所有事件级数据。正在执行的 AI 任务即使稍后返回，
// complete* 函数也会因为任务记录已经不存在而拒绝重新写入。
export function deleteEventCompletely(eventId: string): boolean {
  return db.transaction(() => {
    const exists = db.prepare(`SELECT 1 FROM events WHERE id = ?`).get(eventId);
    if (!exists) return false;
    const timestamp = now();
    // Private support survives the shared event. Detach only its collaboration
    // metadata, without invalidating private messages, notes or running replies.
    db.prepare(`UPDATE private_conversations SET linked_event_id=NULL,linked_side=NULL,updated_at=? WHERE linked_event_id=?`).run(timestamp,eventId);
    // A deleted share cannot be confirmed again through its old idempotent
    // draft. Its owner's private text remains available for a new explicit share.
    db.prepare(`UPDATE private_share_drafts SET status='cancelled',event_id=NULL,version=version+1,updated_at=? WHERE event_id=?`).run(timestamp,eventId);
    db.prepare(`DELETE FROM ai_jobs WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM ai_call_metrics WHERE analytics_event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM analytics_events WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_user_visibility WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM event_deletion_requests WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM partner_event_invite_snoozes WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM guide_sessions WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM guide_messages WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM message_feedback WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM agreements WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM merged WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM perspectives WHERE event_id = ?`).run(eventId);
    db.prepare(`DELETE FROM events WHERE id = ?`).run(eventId);
    return true;
  })();
}

export type SharingRevocationResult = "revoked" | "already_revoked" | "not_found" | "not_participant" | "not_shared";

/** Revoke a participant's authorization to keep shared content in circulation. */
export function revokeEventSharingConsent(eventId: string, userId: string): SharingRevocationResult {
  return db.transaction(() => {
    const event = getEvent(eventId);
    if (!event) return "not_found";
    if (event.a_user_id !== userId && event.b_user_id !== userId) return "not_participant";
    if (event.state === "sharing_revoked") return "already_revoked";

    const a = getPerspective(eventId, "a"), b = getPerspective(eventId, "b");
    const hasConfirmedShare = !!(a?.summary && a.summary_confirmed) || !!(b?.summary && b.summary_confirmed);
    const sharedStates: EventState[] = ["waiting_b", "b_guiding", "b_expressing", "b_summary", "ready_to_merge", "merged", "agreement_proposed", "done", "completed", "declined", "cancelled", "closed", "safety_exit"];
    if (!event.a_share_version && !hasConfirmedShare && !sharedStates.includes(event.state)) return "not_shared";

    const timestamp = now();
    db.prepare(`UPDATE events SET state='sharing_revoked',partner_target_user_id=NULL WHERE id=?`).run(eventId);
    db.prepare(`UPDATE ai_jobs SET status='cancelled',error=NULL,error_code=NULL,updated_at=?
      WHERE event_id=? AND status IN ('queued','processing','failed')`).run(timestamp,eventId);
    db.prepare(`UPDATE perspectives SET summary=NULL,summary_confirmed=0,correction=NULL WHERE event_id=?`).run(eventId);
    db.prepare(`UPDATE merged SET a_confirmed=0,b_confirmed=0 WHERE event_id=?`).run(eventId);
    db.prepare(`UPDATE private_share_drafts SET status='cancelled',event_id=NULL,version=version+1,updated_at=?
      WHERE event_id=? AND status='converted'`).run(timestamp,eventId);
    db.prepare(`UPDATE private_conversations SET linked_event_id=NULL,linked_side=NULL,updated_at=? WHERE linked_event_id=?`).run(timestamp,eventId);
    return "revoked";
  }).immediate();
}

// ---------- perspectives ----------

export function upsertPerspective(eventId: string, role: "a" | "b", rawText: string): void {
  db.prepare(
    `INSERT INTO perspectives (event_id, role, raw_text, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id, role) DO UPDATE SET raw_text = excluded.raw_text`
  ).run(eventId, role, rawText, now());
}

export function getPerspective(eventId: string, role: "a" | "b"): PerspectiveRow | undefined {
  return db
    .prepare(`SELECT * FROM perspectives WHERE event_id = ? AND role = ?`)
    .get(eventId, role) as PerspectiveRow | undefined;
}

export function setSummary(eventId: string, role: "a" | "b", summaryJson: string): void {
  db.prepare(`UPDATE perspectives SET summary = ?, summary_confirmed = 0 WHERE event_id = ? AND role = ?`).run(
    summaryJson,
    eventId,
    role
  );
}

export function confirmSummary(eventId: string, role: "a" | "b"): void {
  db.prepare(`UPDATE perspectives SET summary_confirmed = 1 WHERE event_id = ? AND role = ?`).run(
    eventId,
    role
  );
}

export function setCorrection(eventId: string, role: "a" | "b", correction: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE perspectives SET correction = ? WHERE event_id = ? AND role = ?`).run(
      correction,
      eventId,
      role
    );
    // A correction changes the shared report basis immediately. Keep the prior
    // content as history, but require both people to confirm the new version.
    db.prepare(`UPDATE merged SET a_confirmed = 0, b_confirmed = 0 WHERE event_id = ?`).run(eventId);
  }).immediate();
}

export function acceptMergeCorrection(eventId: string, role: "a" | "b", correction: string): AiJobRow {
  return db.transaction(() => {
    db.prepare(`UPDATE perspectives SET correction = ? WHERE event_id = ? AND role = ?`).run(
      correction,
      eventId,
      role
    );
    // Keep the old report as history, but invalidate its confirmations in the
    // same commit that makes the replacement job visible.
    db.prepare(`UPDATE merged SET a_confirmed = 0, b_confirmed = 0 WHERE event_id = ?`).run(eventId);
    return enqueueAiJob(eventId, "merge_correction", role);
  }).immediate();
}

// ---------- merged ----------

export function scopeMergedForRole(content: MergedUnderstanding, role: "a" | "b"): Partial<MergedUnderstanding> {
  const { a_suggestions, a_partner_view, a_actions, b_suggestions, b_partner_view, b_actions, ...shared } = content;
  return role === "a" ? { ...shared, a_suggestions, a_partner_view, a_actions } : { ...shared, b_suggestions, b_partner_view, b_actions };
}

export function upsertMerged(eventId: string, contentJson: string): void {
  // 每次生成都是新版本：覆盖内容、版本号 +1、双方确认位清零。
  db.prepare(
    `INSERT INTO merged (event_id, content, a_confirmed, b_confirmed, version)
     VALUES (?, ?, 0, 0, 1)
     ON CONFLICT(event_id) DO UPDATE SET
       content = excluded.content,
       a_confirmed = 0,
       b_confirmed = 0,
       version = version + 1`
  ).run(eventId, contentJson);
}

export function getMerged(eventId: string): MergedRow | undefined {
  return db.prepare(`SELECT * FROM merged WHERE event_id = ?`).get(eventId) as MergedRow | undefined;
}

export function mergedReportIsCurrent(eventId: string): boolean {
  const a = getPerspective(eventId, "a");
  const b = getPerspective(eventId, "b");
  if (!a?.correction && !b?.correction) return true;
  const latestCorrection = db.prepare(
    `SELECT * FROM ai_jobs WHERE event_id = ? AND kind = 'merge_correction' ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(eventId) as AiJobRow | undefined;
  return !!latestCorrection && latestCorrection.status === "completed" && mergeJobInputsStillCurrent(latestCorrection);
}

// Shared-event checks use metadata only and require the event owner and linked
// active conversation owner to match on the same side.
export function eventHasActivePrivateRisk(eventId: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM (
      SELECT a_conversation_id AS conversation_id,a_user_id AS owner_user_id FROM events WHERE id=?
      UNION ALL
      SELECT b_conversation_id,b_user_id FROM events WHERE id=?
    ) linked
    JOIN private_conversations c ON c.id=linked.conversation_id AND c.owner_user_id=linked.owner_user_id AND c.status='active'
    JOIN private_risk_state r ON r.conversation_id=c.id
    WHERE linked.conversation_id IS NOT NULL LIMIT 1
  `).get(eventId, eventId);
}

export type MergedRecoveryView = {
  kind: "available" | "blocked" | "history";
  expectedVersion: number | null;
  reason: string;
};

type MergedRecoveryDecision = { view: MergedRecoveryView | null; recoverable: boolean };

function evaluateMergedRecovery(
  eventId: string,
  role: "a" | "b",
  userId: string | null,
  sessionToken: string | null
): MergedRecoveryDecision {
  const event = getEvent(eventId);
  if (!event) return { view: null, recoverable: false };
  const ownsRole = role === "a"
    ? (userId !== null && event.a_user_id === userId) || (!event.a_user_id && !!sessionToken && event.a_token === sessionToken)
    : (userId !== null && event.b_user_id === userId) || (!event.b_user_id && !!sessionToken && event.b_token === sessionToken);
  const merged = getMerged(eventId);
  const expectedVersion = merged?.version ?? null;
  const view = (kind: MergedRecoveryView["kind"], reason: string): MergedRecoveryDecision => ({
    view: { kind, expectedVersion, reason }, recoverable: false,
  });

  if (!ownsRole) return view("blocked", "当前账号无权恢复共同理解");
  if (event.state === "sharing_revoked") return { view: null, recoverable: false };
  if (["agreement_proposed", "done", "completed"].includes(event.state)) {
    if (!merged) return { view: null, recoverable: false };
    const a = getPerspective(eventId, "a"), b = getPerspective(eventId, "b");
    if ((!a?.correction && !b?.correction) || mergedReportIsCurrent(eventId)) {
      return { view: null, recoverable: false };
    }
    return view("history", "当前阶段仅保留历史记录，不支持恢复");
  }
  if (event.state !== "merged" || !merged) return { view: null, recoverable: false };

  const a = getPerspective(eventId, "a"), b = getPerspective(eventId, "b");
  if (!a?.correction && !b?.correction) return { view: null, recoverable: false };
  if (mergedReportIsCurrent(eventId)) return { view: null, recoverable: false };
  if (!a?.summary || !b?.summary || a.summary_confirmed !== 1 || b.summary_confirmed !== 1) {
    return view("blocked", "双方摘要未完成确认，暂不能重新整理");
  }
  if (event.risk_level !== "none" || eventHasActivePrivateRisk(eventId)) {
    return view("blocked", "当前潜谈存在未解除的安全状态，暂不能重新整理");
  }

  const jobs = db.prepare(`SELECT * FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC,rowid DESC`).all(eventId) as AiJobRow[];
  if (jobs.some((job) => job.status === "queued" || job.status === "processing")) {
    return view("blocked", "共同理解正在生成，请稍候");
  }
  if (jobs.some((job) => job.kind.startsWith("merge_") && job.status === "failed" && job.error_code === "AI_RESULT_UNKNOWN")) {
    return view("blocked", "上次生成结果无法确认，暂不能重新生成");
  }
  if (jobs.some((job) => job.kind.startsWith("merge_") && job.status === "failed" && mergeJobInputsStillCurrent(job))) {
    return view("blocked", "已有可重试任务，请从任务提示重试");
  }
  return {
    view: {
      kind: "available",
      expectedVersion,
      reason: "旧生成依据无法核验，可基于当前已确认内容重新生成",
    },
    recoverable: true,
  };
}

export function getMergedRecovery(
  eventId: string,
  role: "a" | "b",
  userId: string | null,
  sessionToken: string | null
): MergedRecoveryView | null {
  return evaluateMergedRecovery(eventId, role, userId, sessionToken).view;
}

export type RecoverMergedResult =
  | { status: "queued"; job: AiJobRow }
  | { status: "stale"; expectedVersion: number | null }
  | { status: "unavailable"; view: MergedRecoveryView | null };

export function recoverMergedReport(
  eventId: string,
  role: "a" | "b",
  userId: string | null,
  sessionToken: string | null,
  expectedVersion: number
): RecoverMergedResult {
  return db.transaction(() => {
    const current = getMerged(eventId);
    if (!current || current.version !== expectedVersion) {
      return { status: "stale", expectedVersion: current?.version ?? null } as const;
    }
    const decision = evaluateMergedRecovery(eventId, role, userId, sessionToken);
    if (!decision.recoverable) return { status: "unavailable", view: decision.view } as const;

    // Old failed jobs remain in history; mark them cancelled before adding a fresh
    // source snapshot so the ordinary retry path cannot revive stale inputs.
    db.prepare(`UPDATE ai_jobs SET status='cancelled',updated_at=?
      WHERE event_id=? AND kind IN ('merge_initial','merge_correction') AND status='failed'
        AND (error_code IS NULL OR error_code!='AI_RESULT_UNKNOWN')`).run(now(), eventId);
    db.prepare(`UPDATE merged SET a_confirmed=0,b_confirmed=0 WHERE event_id=? AND version=?`).run(eventId, expectedVersion);
    const job = enqueueAiJob(eventId, "merge_correction", role);
    return { status: "queued", job } as const;
  }).immediate();
}

export function confirmMerged(eventId: string, role: "a" | "b", expectedVersion?: number): boolean {
  const col = role === "a" ? "a_confirmed" : "b_confirmed";
  const result = expectedVersion === undefined
    ? db.prepare(`UPDATE merged SET ${col} = 1 WHERE event_id = ?`).run(eventId)
    : db.prepare(`UPDATE merged SET ${col} = 1 WHERE event_id = ? AND version = ?`).run(eventId, expectedVersion);
  return result.changes > 0;
}

// ---------- agreements ----------

export function setChoice(eventId: string, role: "a" | "b", choice: string): void {
  const row = db.prepare(`SELECT choices FROM agreements WHERE event_id = ?`).get(eventId) as
    | { choices: string | null }
    | undefined;
  const cur = row?.choices ? (JSON.parse(row.choices) as Record<string, string>) : {};
  cur[role] = choice;
  db.prepare(
    `INSERT INTO agreements (event_id, choices, done) VALUES (?, ?, 0)
     ON CONFLICT(event_id) DO UPDATE SET choices = excluded.choices`
  ).run(eventId, JSON.stringify(cur));
}

export function getChoices(eventId: string): { a?: string; b?: string } {
  const row = db.prepare(`SELECT choices FROM agreements WHERE event_id = ?`).get(eventId) as
    | { choices: string | null }
    | undefined;
  return row?.choices ? (JSON.parse(row.choices) as { a?: string; b?: string }) : {};
}

export function markAgreementDone(eventId: string): void {
  const dueAt = now() + 7 * 24 * 60 * 60 * 1000; // 约定 7 天后复访
  db.prepare(`UPDATE agreements SET done = 1, due_at = ? WHERE event_id = ?`).run(dueAt, eventId);
}

export function getAgreement(eventId: string): AgreementRow | undefined {
  return db.prepare(`SELECT * FROM agreements WHERE event_id = ?`).get(eventId) as
    | AgreementRow
    | undefined;
}

// ---------- review（到期复访，双方分别提交，互不可见直到都提交） ----------

export function setReview(eventId: string, role: "a" | "b", reviewJson: string): void {
  const col = role === "a" ? "a_review" : "b_review";
  db.prepare(`UPDATE agreements SET ${col} = ? WHERE event_id = ?`).run(reviewJson, eventId);
}

export function getReviews(eventId: string): { a?: string; b?: string } {
  const row = db.prepare(`SELECT a_review, b_review FROM agreements WHERE event_id = ?`).get(
    eventId
  ) as { a_review: string | null; b_review: string | null } | undefined;
  return { a: row?.a_review ?? undefined, b: row?.b_review ?? undefined };
}

export function bothReviewed(eventId: string): boolean {
  const r = getReviews(eventId);
  return !!(r.a && r.b);
}

// ---------- guide messages（A/B 各自的私密引导对话，按 side 区分） ----------

export type GuideSide = "a" | "b";

export interface GuideMessage {
  id: number;
  role: GuideSide | "ai";
  content: string;
  createdAt: number;
}

export function addGuideMessage(
  eventId: string,
  side: GuideSide,
  role: GuideSide | "ai",
  content: string
): number {
  const result = db.prepare(
    `INSERT INTO guide_messages (event_id, side, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(eventId, side, role, content, now());
  return Number(result.lastInsertRowid);
}

export function getGuideMessages(eventId: string, side: GuideSide): GuideMessage[] {
  const rows = db
    .prepare(`SELECT id, role, content, created_at FROM guide_messages WHERE event_id = ? AND side = ? ORDER BY id ASC`)
    .all(eventId, side) as unknown as { id: number; role: string; content: string; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    role: r.role as GuideMessage["role"],
    content: String(r.content),
    createdAt: r.created_at,
  }));
}

export function getGuideMessagesBefore(
  eventId: string,
  side: GuideSide,
  beforeId: number
): GuideMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, created_at FROM guide_messages
       WHERE event_id = ? AND side = ? AND id < ? ORDER BY id ASC`
    )
    .all(eventId, side, beforeId) as unknown as { id: number; role: string; content: string; created_at: number }[];
  return rows.map((row) => ({
    id: row.id,
    role: row.role as GuideMessage["role"],
    content: String(row.content),
    createdAt: row.created_at,
  }));
}

function isLatestUserGuideMessage(
  eventId: string,
  side: GuideSide,
  messageId: number
): boolean {
  const latest = db
    .prepare(
      `SELECT id FROM guide_messages
       WHERE event_id = ? AND side = ? AND role = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(eventId, side, side) as { id: number } | undefined;
  return latest?.id === messageId;
}

export function editGuideMessageAndRewind(
  eventId: string,
  side: GuideSide,
  messageId: number,
  content: string,
  emptyStoryMapJson: string
): boolean {
  return db.transaction(() => {
    if (!isLatestUserGuideMessage(eventId, side, messageId)) return false;
    const target = db
      .prepare(
        `SELECT id FROM guide_messages
         WHERE id = ? AND event_id = ? AND side = ? AND role = ?`
      )
      .get(messageId, eventId, side, side) as { id: number } | undefined;
    if (!target) return false;

    db.prepare(
      `DELETE FROM personal_preferences
       WHERE source_message_id IN (
         SELECT id FROM guide_messages
         WHERE event_id = ? AND side = ? AND id >= ?
       )`
    ).run(eventId, side, messageId);
    db.prepare(`UPDATE guide_messages SET content = ? WHERE id = ?`).run(content, messageId);
    db.prepare(
      `DELETE FROM guide_messages WHERE event_id = ? AND side = ? AND id > ?`
    ).run(eventId, side, messageId);
    db.prepare(
      `UPDATE ai_jobs SET status = 'cancelled', error = NULL, updated_at = ?
       WHERE event_id = ? AND side = ? AND status IN ('queued', 'processing', 'failed')`
    ).run(now(), eventId, side);
    saveGuideSession(eventId, side, "story", emptyStoryMapJson);
    return true;
  })();
}

export function restartGuideFromMessage(
  eventId: string,
  side: GuideSide,
  messageId: number,
  reason: string,
  emptyStoryMapJson: string
): boolean {
  return db.transaction(() => {
    const latest = db
      .prepare(
        `SELECT id, role FROM guide_messages
         WHERE event_id = ? AND side = ? ORDER BY id DESC LIMIT 1`
      )
      .get(eventId, side) as { id: number; role: string } | undefined;
    if (!latest || latest.role !== "ai") return false;
    if (!isLatestUserGuideMessage(eventId, side, messageId)) return false;

    const target = db
      .prepare(
        `SELECT id FROM guide_messages
         WHERE id = ? AND event_id = ? AND side = ? AND role = ?`
      )
      .get(messageId, eventId, side, side) as { id: number } | undefined;
    if (!target) return false;
    db.prepare(`DELETE FROM guide_messages WHERE event_id = ? AND side = ? AND id > ?`)
      .run(eventId, side, messageId);
    db.prepare(
      `UPDATE ai_jobs SET status = 'cancelled', error = NULL, updated_at = ?
       WHERE event_id = ? AND side = ? AND status IN ('queued', 'processing', 'failed')`
    ).run(now(), eventId, side);
    if (reason) {
      db.prepare(
        `INSERT INTO message_feedback (event_id, side, user_message_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(eventId, side, messageId, reason, now());
    }
    saveGuideSession(eventId, side, "story", emptyStoryMapJson);
    return true;
  })();
}

export function deleteGuideMessageAndFollowing(
  eventId: string,
  side: GuideSide,
  messageId: number,
  emptyStoryMapJson: string
): boolean {
  return db.transaction(() => {
    if (!isLatestUserGuideMessage(eventId, side, messageId)) return false;
    const target = db
      .prepare(
        `SELECT id FROM guide_messages
         WHERE id = ? AND event_id = ? AND side = ? AND role = ?`
      )
      .get(messageId, eventId, side, side) as { id: number } | undefined;
    if (!target) return false;
    db.prepare(
      `DELETE FROM personal_preferences
       WHERE source_message_id IN (
         SELECT id FROM guide_messages
         WHERE event_id = ? AND side = ? AND id >= ?
       )`
    ).run(eventId, side, messageId);
    db.prepare(`DELETE FROM guide_messages WHERE event_id = ? AND side = ? AND id >= ?`)
      .run(eventId, side, messageId);
    db.prepare(
      `UPDATE ai_jobs SET status = 'cancelled', error = NULL, updated_at = ?
       WHERE event_id = ? AND side = ? AND status IN ('queued', 'processing', 'failed')`
    ).run(now(), eventId, side);
    saveGuideSession(eventId, side, "story", emptyStoryMapJson);
    return true;
  })();
}

export function cancelVisibleAiJob(eventId: string, side: GuideSide): boolean {
  const result = db.prepare(
    `UPDATE ai_jobs SET status = 'cancelled', error = NULL, updated_at = ?
     WHERE event_id = ? AND side = ? AND status IN ('queued', 'processing')`
  ).run(now(), eventId, side);
  return result.changes > 0;
}

export function getGuideMessageById(
  id: number
): { id: number; event_id: string; side: GuideSide; role: GuideMessage["role"]; content: string } | undefined {
  return db
    .prepare(`SELECT id, event_id, side, role, content FROM guide_messages WHERE id = ?`)
    .get(id) as
    | { id: number; event_id: string; side: GuideSide; role: GuideMessage["role"]; content: string }
    | undefined;
}

export function saveGuideSession(
  eventId: string,
  side: GuideSide,
  stage: GuideSessionRow["stage"],
  storyMapJson: string
): void {
  db.prepare(
    `INSERT INTO guide_sessions (event_id, side, stage, story_map, story_confirmed, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(event_id, side) DO UPDATE SET
       stage = excluded.stage,
       story_map = excluded.story_map,
       story_confirmed = 0,
       updated_at = excluded.updated_at`
  ).run(eventId, side, stage, storyMapJson, now());
}

export function getGuideSession(eventId: string, side: GuideSide): GuideSessionRow | undefined {
  return db
    .prepare(`SELECT * FROM guide_sessions WHERE event_id = ? AND side = ?`)
    .get(eventId, side) as GuideSessionRow | undefined;
}

export function confirmGuideStory(eventId: string, side: GuideSide): void {
  db.prepare(
    `UPDATE guide_sessions SET story_confirmed = 1, updated_at = ? WHERE event_id = ? AND side = ?`
  ).run(now(), eventId, side);
}

export function reopenSummaryToGuiding(eventId: string, side: GuideSide): boolean {
  const fromState: EventState = side === "a" ? "a_summary" : "b_summary";
  const toState: EventState = side === "a" ? "a_guiding" : "b_guiding";
  return db.transaction(() => {
    const result = db
      .prepare(`UPDATE events SET state = ? WHERE id = ? AND state = ?`)
      .run(toState, eventId, fromState);
    if (result.changes === 0) return false;
    db.prepare(
      `UPDATE perspectives SET summary = NULL, summary_confirmed = 0
       WHERE event_id = ? AND role = ?`
    ).run(eventId, side);
    db.prepare(
      `UPDATE guide_sessions
       SET stage = 'checkin', story_confirmed = 0, updated_at = ?
       WHERE event_id = ? AND side = ?`
    ).run(now(), eventId, side);
    return true;
  })();
}

// ---------- durable AI jobs ----------

export function enqueueAiJob(
  eventId: string,
  kind: AiJobKind,
  side: GuideSide | null = null,
  userMessageId: number | null = null
): AiJobRow {
  const id = crypto.randomUUID();
  const timestamp = now();
  const sourceSnapshot = kind === "merge_initial" || kind === "merge_correction"
    ? (() => {
      const a = getPerspective(eventId, "a");
      const b = getPerspective(eventId, "b");
      return a?.summary && b?.summary
        ? crypto.createHash("sha256").update(JSON.stringify({ a: a.summary, b: b.summary, aCorrection: kind === "merge_correction" ? a.correction : null, bCorrection: kind === "merge_correction" ? b.correction : null })).digest("hex")
        : null;
    })()
    : null;
  db.prepare(
    `INSERT INTO ai_jobs
      (id, event_id, kind, side, user_message_id, status, attempts, error, error_code, source_snapshot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, ?)`
  ).run(id, eventId, kind, side, userMessageId, sourceSnapshot, timestamp, timestamp);
  return getAiJob(id)!;
}

export function mergeJobInputsStillCurrent(job:AiJobRow):boolean {
  if(job.kind!=="merge_initial"&&job.kind!=="merge_correction")return true;
  if(!job.source_snapshot)return false;
  const a=getPerspective(job.event_id,"a"),b=getPerspective(job.event_id,"b");
  if(!a?.summary||!b?.summary||a.summary_confirmed!==1||b.summary_confirmed!==1)return false;
  const snapshot=crypto.createHash("sha256").update(JSON.stringify({a:a.summary,b:b.summary,aCorrection:job.kind==="merge_correction"?a.correction:null,bCorrection:job.kind==="merge_correction"?b.correction:null})).digest("hex");
  return snapshot===job.source_snapshot;
}

export function getAiJob(id: string): AiJobRow | undefined {
  return db.prepare(`SELECT * FROM ai_jobs WHERE id = ?`).get(id) as AiJobRow | undefined;
}

export function getUnresolvedAiJob(eventId: string): AiJobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM ai_jobs
       WHERE event_id = ? AND status IN ('queued', 'processing', 'failed')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(eventId) as AiJobRow | undefined;
}

export function getVisibleAiJob(eventId: string, side: GuideSide): AiJobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM ai_jobs
       WHERE event_id = ?
         AND status IN ('queued', 'processing', 'failed')
         AND (kind IN ('merge_initial', 'merge_correction') OR side = ?)
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(eventId, side) as AiJobRow | undefined;
}

const claimNextAiJobTransaction = db.transaction((): AiJobRow | undefined => {
  const next = db
    .prepare(`SELECT * FROM ai_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
    .get() as AiJobRow | undefined;
  if (!next) return undefined;
  const result = db
    .prepare(
      `UPDATE ai_jobs
       SET status = 'processing', attempts = attempts + 1, error = NULL, error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    )
    .run(now(), next.id);
  return result.changes > 0 ? getAiJob(next.id) : undefined;
});

export function claimNextAiJob(): AiJobRow | undefined {
  return claimNextAiJobTransaction();
}

export function hasQueuedAiJob(): boolean {
  return !!db.prepare(`SELECT 1 FROM ai_jobs WHERE status = 'queued' LIMIT 1`).get();
}

export function requeueInterruptedAiJobs(): void {
  db.prepare(
    `UPDATE ai_jobs
     SET status = CASE WHEN kind IN ('merge_initial','merge_correction') THEN 'failed' ELSE 'queued' END,
         error = CASE WHEN kind IN ('merge_initial','merge_correction') THEN ? ELSE NULL END,
         error_code = CASE WHEN kind IN ('merge_initial','merge_correction') THEN 'AI_RESULT_UNKNOWN' ELSE NULL END,
         updated_at = ? WHERE status = 'processing'`
  ).run("共同理解未完成。双方确认的摘要已保存；上一次请求结果尚不确定，暂不会自动重新生成。你可以刷新查看状态。", now());
}

export function failAiJob(
  id: string,
  error: string,
  errorCode: string | null = null,
  expectedAttempts?: number
): void {
  db.prepare(
    `UPDATE ai_jobs SET status = 'failed', error = ?, error_code = ?, updated_at = ?
     WHERE id = ? AND status = 'processing' AND (? IS NULL OR attempts = ?)`
  ).run(error, errorCode, now(), id, expectedAttempts ?? null, expectedAttempts ?? null);
}

export function cancelAiJob(id: string): void {
  db.prepare(`UPDATE ai_jobs SET status='cancelled',error=NULL,error_code=NULL,updated_at=?
    WHERE id=? AND status IN ('queued','processing')`).run(now(), id);
}

export function aiJobInputsAreAllowed(job: AiJobRow): boolean {
  const event = getEvent(job.event_id);
  if (!event || event.risk_level !== "none") return false;
  if (job.kind === "merge_initial") return !eventHasActivePrivateRisk(job.event_id) && event.state === "b_summary" && mergeJobInputsStillCurrent(job);
  if (job.kind === "merge_correction") return !eventHasActivePrivateRisk(job.event_id) && event.state === "merged" && mergeJobInputsStillCurrent(job);
  if (!job.side || event.state !== (job.side === "a" ? "a_guiding" : "b_guiding")) return false;
  if (job.kind === "guide") {
    const source = job.user_message_id ? getGuideMessageById(job.user_message_id) : undefined;
    return !!source && source.event_id === job.event_id && source.side === job.side && source.role === job.side;
  }
  return true;
}

export function endGuideSession(eventId: string, side: GuideSide): boolean {
  const fromState: EventState = side === "a" ? "a_guiding" : "b_guiding";
  return db.transaction(() => {
    const result = db
      .prepare(`UPDATE events SET state = 'closed' WHERE id = ? AND state = ?`)
      .run(eventId, fromState);
    if (result.changes === 0) return false;
    db.prepare(
      `UPDATE ai_jobs SET status = 'cancelled', error = NULL, updated_at = ?
       WHERE event_id = ? AND status IN ('queued', 'processing', 'failed')`
    ).run(now(), eventId);
    return true;
  })();
}

export function retryVisibleAiJob(
  eventId: string,
  side: GuideSide,
  expectedJobId?: string,
  expectedAttempt?: number
): boolean {
  const job = getVisibleAiJob(eventId, side);
  if (!job || job.status !== "failed" || job.error_code === "AI_RESULT_UNKNOWN") return false;
  if ((job.kind === "merge_initial" || job.kind === "merge_correction") && !aiJobInputsAreAllowed(job)) return false;
  if ((expectedJobId !== undefined && job.id !== expectedJobId) ||
      (expectedAttempt !== undefined && job.attempts !== expectedAttempt) ||
      ((expectedJobId === undefined) !== (expectedAttempt === undefined))) return false;
  const result = db
    .prepare(
      `UPDATE ai_jobs SET status = 'queued', error = NULL, error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed'
         AND (error_code IS NULL OR error_code != 'AI_RESULT_UNKNOWN')
         AND (? IS NULL OR attempts = ?)`
    )
    .run(now(), job.id, expectedAttempt ?? null, expectedAttempt ?? null);
  return result.changes > 0;
}

export function completeGuideAiJob(
  job: AiJobRow,
  reply: string,
  stage: GuideSessionRow["stage"],
  storyMapJson: string,
  preferenceUserId?: string | null,
  preferenceSignals: { category: string; setting: string }[] = []
): void {
  db.transaction(() => {
    const current = getAiJob(job.id);
    if (current?.status !== "processing") return;
    if (!aiJobInputsAreAllowed(current)) { cancelAiJob(current.id); return; }
    addGuideMessage(job.event_id, job.side as GuideSide, "ai", reply);
    saveGuideSession(job.event_id, job.side as GuideSide, stage, storyMapJson);
    if (preferenceUserId) {
      for (const signal of preferenceSignals) {
        upsertPersonalPreference(
          preferenceUserId,
          signal.category,
          signal.setting,
          job.user_message_id
        );
      }
    }
    db.prepare(
      `UPDATE ai_jobs SET status = 'completed', error = NULL, error_code = NULL, updated_at = ? WHERE id = ?`
    ).run(now(), job.id);
  })();
}

export function completeSummaryAiJob(
  job: AiJobRow,
  summaryJson: string,
  fromState: EventState
): void {
  db.transaction(() => {
    const current = getAiJob(job.id);
    if (current?.status !== "processing") return;
    if (!aiJobInputsAreAllowed(current)) { cancelAiJob(current.id); return; }
    const side = job.side as GuideSide;
    setSummary(job.event_id, side, summaryJson);
    confirmGuideStory(job.event_id, side);
    if (!transition(job.event_id, fromState, side === "a" ? "a_summary" : "b_summary")) {
      throw new Error("event state changed while completing summary job");
    }
    db.prepare(
      `UPDATE ai_jobs SET status = 'completed', error = NULL, error_code = NULL, updated_at = ? WHERE id = ?`
    ).run(now(), job.id);
  })();
}

export function completeMergeAiJob(job: AiJobRow, mergedJson: string): void {
  db.transaction(() => {
    const current = getAiJob(job.id);
    if (current?.status !== "processing" || current.attempts !== job.attempts) return;
    if (!aiJobInputsAreAllowed(current)) { cancelAiJob(current.id); return; }
    const a = getPerspective(job.event_id, "a");
    const b = getPerspective(job.event_id, "b");
    if (!a?.summary || !b?.summary || a.summary_confirmed !== 1 || b.summary_confirmed !== 1 || !mergeJobInputsStillCurrent(job)) {
      db.prepare(`UPDATE ai_jobs SET status = 'cancelled', error = 'confirmed summaries changed', error_code = NULL, updated_at = ? WHERE id = ?`).run(now(), job.id);
      return;
    }
    upsertMerged(job.event_id, mergedJson);
    if (job.kind === "merge_initial") {
      if (!transition(job.event_id, "b_summary", "merged")) {
        throw new Error("event state changed while completing merge job");
      }
    }
    db.prepare(
      `UPDATE ai_jobs SET status = 'completed', error = NULL, error_code = NULL, updated_at = ? WHERE id = ?`
    ).run(now(), job.id);
  })();
}
