import { bindTwoCallPrivateJob, twoCallPrivateJobEligible, twoCallGuardConfigured, getTwoCallGuardState, stopTwoCallJob, completeTwoCallJob } from "./two-call-guard.js";
import { notesDispatchGuardConfigured, notesPrivateJobEligible, completeNotesDispatchJob, stopNotesDispatchJob, recoverInterruptedNotesDispatch } from "./notes-dispatch-guard.js";
import crypto from "node:crypto";
import { db, eventHasActivePrivateRisk, getActivePartnerUserId, createEvent, setSummary, confirmSummary, transition, targetActivePartnerForEvent, enqueueAiJob, getEvent, getPerspective, upsertPerspective, pruneExpiredAnalytics } from "./db.js";
import { assessPrivateRisk } from "./ai.js";
import { applyNaturalMemoryCorrection, invalidatePrivateMemorySource, markPrivateMemorySourceChanged, privateMemorySnapshotStillCurrent, syncCorrectedNoteToMemory, syncPrivateMemoryFromNotes, type MemoryReplySnapshot } from "./private-memory.js";

const id = () => crypto.randomUUID();
const now = () => Date.now();

export type PrivateJobKind = "reply" | "notes" | "share_draft";
export type PrivateJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export const REPLY_FEEDBACK_REASONS = ["natural","clear","helpful_advice","mechanical","too_many_questions","too_much_advice","too_distant","misunderstood"] as const;
export type ReplyFeedbackReason = typeof REPLY_FEEDBACK_REASONS[number];
export type ReplyFeedbackRating = "up" | "down";
export interface ReplyFeedback { rating: ReplyFeedbackRating; reason: ReplyFeedbackReason | null; }
export interface LatestTurn { userMessageId: string | null; assistantMessageId: string | null; }

const REASONS_BY_RATING:Record<ReplyFeedbackRating,readonly ReplyFeedbackReason[]>={
  up:["natural","clear","helpful_advice"],
  down:["mechanical","too_many_questions","too_much_advice","too_distant","misunderstood"],
};
const RESPONSE_PREFERENCE_BY_REASON:Partial<Record<ReplyFeedbackReason,{category:string;description:string}>>={
  natural:{category:"tone",description:"表达自然，避免机械感"},
  clear:{category:"directness",description:"表达直接清楚"},
  helpful_advice:{category:"support_style",description:"用户需要建议时提供可选方法"},
  mechanical:{category:"tone",description:"表达自然，避免机械感"},
  too_many_questions:{category:"question_pacing",description:"少追问，一次最多问一个问题"},
  too_much_advice:{category:"support_style",description:"先倾听理解，用户需要时再提供建议"},
  too_distant:{category:"pause_reminder",description:"自然承接愿意继续的表达，非必要不提醒暂停或不必展开"},
};

export function isReplyFeedbackReason(value:unknown):value is ReplyFeedbackReason {
  return typeof value==="string"&&(REPLY_FEEDBACK_REASONS as readonly string[]).includes(value);
}
export function isValidReplyFeedback(rating:unknown,reason:unknown):boolean {
  if(rating===null)return reason===undefined||reason===null;
  return (rating==="up"||rating==="down")&&(reason===undefined||reason===null||
    (isReplyFeedbackReason(reason)&&REASONS_BY_RATING[rating].includes(reason)));
}

export interface PrivateJob {
  id: string; kind: PrivateJobKind; status: PrivateJobStatus; inputVersion: number;
  createdAt: number; updatedAt: number; errorCode?: string; sourceMessageId?: string | null; resultMessageId?: string;
}

export interface PrivateConversation {
  id: string; title: string; createdAt: number; updatedAt: number; version: number;
  status: "active" | "deleted"; lastMessageAt: number | null; pendingJobCount: number;
  linkedEventId?: string; linkedSide?: "a" | "b"; safetyStatus: "clear" | "active";
}

export interface PrivateMessage {
  id: string; role: "user" | "assistant"; content: string; version: number;
  createdAt: number; status: "current" | "superseded";
}

export interface PrivateNote {
  id: string; kind: "user_statement" | "tentative_understanding" | "unknown"; content: string;
  sourceMessageIds: string[]; sourceConversationVersion: number; version: number;
  status: "current" | "stale" | "corrected"; correction?: string; updatedAt: number;
}

export interface ShareDraft {
  id: string; content: string; version: number; status: "draft" | "confirmed" | "converted" | "cancelled";
  sourceMessageIds: string[]; createdAt: number; updatedAt: number; eventId?: string;
}

interface ConversationRow {
  id: string; owner_user_id: string; title: string; status: "active" | "deleted"; version: number;
  created_at: number; updated_at: number; last_message_at: number | null;
  linked_event_id: string | null; linked_side: string | null;
}
interface MessageRow {
  id: string; role: "user" | "assistant"; content: string; version: number; status: "current" | "superseded";
  created_at: number; client_request_id: string | null;
}
interface JobRow {
  id: string; owner_user_id: string; conversation_id: string; kind: PrivateJobKind; input_version: number;
  source_message_id: string | null; source_message_version: number | null; payload: string; status: PrivateJobStatus;
  error_code: string | null; result_message_id: string | null; created_at: number; updated_at: number;
}
interface NoteRow {
  id: string; conversation_id: string; kind: PrivateNote["kind"]; content: string; source_message_ids: string;
  source_message_versions: string; source_conversation_version: number; version: number; status: PrivateNote["status"];
  correction: string | null; updated_at: number;
}
interface DraftRow {
  id: string; conversation_id: string; content: string; source_message_ids: string; version: number;
  status: ShareDraft["status"]; created_at: number; updated_at: number; event_id: string | null;
}

function conversation(row: ConversationRow): PrivateConversation {
  const pending = db.prepare(`SELECT COUNT(*) AS count FROM private_jobs WHERE conversation_id=? AND status IN ('queued','processing')`).get(row.id) as { count: number };
  const risk = db.prepare(`SELECT 1 FROM private_risk_state WHERE conversation_id=?`).get(row.id);
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
    version: row.version, status: row.status, lastMessageAt: row.last_message_at, pendingJobCount: pending.count,
    ...(row.linked_event_id ? { linkedEventId: row.linked_event_id } : {}),
    ...(row.linked_side === "a" || row.linked_side === "b" ? { linkedSide: row.linked_side } : {}),
    safetyStatus: risk ? "active" : "clear" };
}
function message(row: MessageRow): PrivateMessage {
  return { id: row.id, role: row.role, content: row.content, version: row.version, createdAt: row.created_at, status: row.status };
}
function note(row: NoteRow): PrivateNote {
  return { id: row.id, kind: row.kind, content: row.content, sourceMessageIds: JSON.parse(row.source_message_ids),
    sourceConversationVersion: row.source_conversation_version, version: row.version, status: row.status,
    ...(row.correction ? { correction: row.correction } : {}), updatedAt: row.updated_at };
}
function draft(row: DraftRow): ShareDraft {
  return { id: row.id, content: row.content, version: row.version, status: row.status,
    sourceMessageIds: JSON.parse(row.source_message_ids), createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.event_id ? { eventId: row.event_id } : {}) };
}
function job(row: JobRow): PrivateJob {
  return { id: row.id, kind: row.kind, status: row.status, inputVersion: row.input_version,
    createdAt: row.created_at, updatedAt: row.updated_at, ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.result_message_id ? { resultMessageId: row.result_message_id } : {}) };
}

function refreshPrivateRisk(conversationId:string):void {
  const messages=listCurrentMessages(conversationId).filter(item=>item.role==="user").map(({id,role,content})=>({id,role,content}));
  const risk=assessPrivateRisk(messages);
  if(risk.situation) db.prepare(`INSERT INTO private_risk_state(conversation_id,situation,source_message_ids,updated_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET situation=excluded.situation,source_message_ids=excluded.source_message_ids,updated_at=excluded.updated_at`).run(conversationId,risk.situation,JSON.stringify(risk.sourceMessageIds),now());
  else db.prepare(`DELETE FROM private_risk_state WHERE conversation_id=?`).run(conversationId);
}

export function conversationHasActiveRisk(userId:string,conversationId:string):boolean {
  return !!db.prepare(`SELECT 1 FROM private_risk_state r JOIN private_conversations c ON c.id=r.conversation_id WHERE r.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(conversationId,userId);
}

export function getActiveRiskMessages(userId:string,conversationId:string):PrivateMessage[] {
  const row=db.prepare(`SELECT r.source_message_ids FROM private_risk_state r JOIN private_conversations c ON c.id=r.conversation_id WHERE r.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(conversationId,userId) as {source_message_ids:string}|undefined;
  if(!row)return [];
  const ids=JSON.parse(row.source_message_ids) as string[];
  if(!ids.length)return [];
  return (db.prepare(`SELECT * FROM private_messages WHERE conversation_id=? AND id IN (${ids.map(()=>"?").join(",")}) AND role='user' AND status='current' ORDER BY created_at,rowid`).all(conversationId,...ids) as MessageRow[]).map(message);
}

export function hasSafetyReplyAfterActiveRisk(userId:string,conversationId:string):boolean {
  const row=db.prepare(`SELECT r.source_message_ids FROM private_risk_state r JOIN private_conversations c ON c.id=r.conversation_id WHERE r.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(conversationId,userId) as {source_message_ids:string}|undefined;
  if(!row)return false;
  const ids=JSON.parse(row.source_message_ids) as string[]; if(!ids.length)return false;
  const segmentStart=db.prepare(`SELECT MIN(rowid) sequence FROM private_messages WHERE conversation_id=? AND id IN (${ids.map(()=>"?").join(",")})`).get(conversationId,...ids) as {sequence:number|null};
  return segmentStart.sequence!==null&&!!db.prepare(`SELECT 1 FROM private_messages WHERE conversation_id=? AND role='assistant' AND status='current' AND is_safety_response=1 AND rowid>? LIMIT 1`).get(conversationId,segmentStart.sequence);
}

export function getOwnedConversation(userId: string, conversationId: string): ConversationRow | undefined {
  return db.prepare(`SELECT * FROM private_conversations WHERE id=? AND owner_user_id=? AND status='active'`).get(conversationId, userId) as ConversationRow | undefined;
}

export function createConversation(userId: string, title = "", link?: { eventId: string; side: "a" | "b" }): PrivateConversation {
  const timestamp = now();
  const conversationId = id();
  db.prepare(`INSERT INTO private_conversations(id,owner_user_id,title,created_at,updated_at,last_message_at,linked_event_id,linked_side)
    VALUES(?,?,?,?,?,?,?,?)`).run(conversationId, userId, title.slice(0, 80), timestamp, timestamp, null, link?.eventId ?? null, link?.side ?? null);
  if (link) db.prepare(`UPDATE events SET ${link.side === "a" ? "a_conversation_id" : "b_conversation_id"}=? WHERE id=? AND ${link.side}_user_id=?`).run(conversationId, link.eventId, userId);
  return getConversationById(userId, conversationId)!;
}

export function createConversationWithRequestId(userId:string,title:string,clientRequestId:string):{conversation:PrivateConversation|null;created:boolean;retired:boolean} {
  return db.transaction(()=>{
    const existing=db.prepare(`SELECT * FROM private_conversations WHERE owner_user_id=? AND client_request_id=?`).get(userId,clientRequestId) as ConversationRow|undefined;
    if(existing) return {conversation:existing.status==="active"?conversation(existing):null,created:false,retired:existing.status!=="active"};
    const timestamp=now(),conversationId=id();
    db.prepare(`INSERT INTO private_conversations(id,owner_user_id,title,created_at,updated_at,last_message_at,linked_event_id,linked_side,client_request_id)
      VALUES(?,?,?,?,?,?,NULL,NULL,?)`).run(conversationId,userId,title.slice(0,80),timestamp,timestamp,null,clientRequestId);
    return {conversation:getConversationById(userId,conversationId),created:true,retired:false};
  }).immediate();
}

export function getConversationById(userId: string, conversationId: string): PrivateConversation | null {
  const row = getOwnedConversation(userId, conversationId);
  return row ? conversation(row) : null;
}

export function listConversations(userId: string): PrivateConversation[] {
  const rows = db.prepare(`SELECT * FROM private_conversations WHERE owner_user_id=? AND status='active' ORDER BY updated_at DESC`).all(userId) as ConversationRow[];
  return rows.map(conversation);
}

export function getConversationDetail(userId: string, conversationId: string) {
  const row = getOwnedConversation(userId, conversationId);
  if (!row) return null;
  const messages = db.prepare(`SELECT * FROM private_messages WHERE conversation_id=? ORDER BY created_at,rowid`).all(conversationId) as MessageRow[];
  const notes = db.prepare(`SELECT * FROM private_notes WHERE conversation_id=? ORDER BY updated_at DESC`).all(conversationId) as NoteRow[];
  const drafts = db.prepare(`SELECT * FROM private_share_drafts WHERE conversation_id=? ORDER BY updated_at DESC`).all(conversationId) as DraftRow[];
  const recentJobs = db.prepare(`SELECT * FROM private_jobs p WHERE p.conversation_id=? AND (p.status IN ('queued','processing') OR p.rowid=(SELECT MAX(p2.rowid) FROM private_jobs p2 WHERE p2.conversation_id=p.conversation_id AND p2.kind=p.kind)) ORDER BY p.created_at,p.rowid`).all(conversationId) as JobRow[];
  const pendingRow=recentJobs.find(item=>item.kind==="reply" && ["queued","processing","failed"].includes(item.status));
  const current=messages.filter(item=>item.status==="current").map(message);
  const latestTurn=latestTurnForMessages(current);
  const feedback=latestTurn.assistantMessageId?db.prepare(`SELECT f.rating,f.reason,f.source_message_id,f.source_message_version,f.assistant_message_version,m.version source_version,a.version assistant_version FROM private_reply_feedback f JOIN private_messages m ON m.id=f.source_message_id JOIN private_messages a ON a.id=f.assistant_message_id WHERE f.owner_user_id=? AND f.conversation_id=? AND f.assistant_message_id=? AND m.status='current' AND a.status='current'`).get(userId,conversationId,latestTurn.assistantMessageId) as {rating:ReplyFeedbackRating;reason:ReplyFeedbackReason|null;source_message_id:string;source_message_version:number;assistant_message_version:number;source_version:number;assistant_version:number}|undefined:undefined;
  const replyFeedback=feedback&&feedback.source_message_id===latestTurn.userMessageId&&feedback.source_message_version===feedback.source_version&&feedback.assistant_message_version===feedback.assistant_version?{rating:feedback.rating,reason:feedback.reason}:null;
  return { conversation: conversation(row), messages: messages.map(message), notes: notes.map(note), pendingJob: pendingRow ? job(pendingRow) : null,
    latestTurn, replyFeedback, responsePreferences:listResponsePreferences(userId,conversationId),
    jobs:recentJobs.map(job), shareDrafts: drafts.map(({ id: draftId, version, status, created_at, updated_at }) => ({ id: draftId, version, status, createdAt: created_at, updatedAt: updated_at })) };
}

function latestTurnForMessages(messages:PrivateMessage[]):LatestTurn {
  let userMessageId:string|null=null,assistantMessageId:string|null=null;
  for(const item of messages) if(item.role==="user") {userMessageId=item.id;assistantMessageId=null;} else if(userMessageId) assistantMessageId=item.id;
  return {userMessageId,assistantMessageId};
}

export function listResponsePreferences(userId:string,conversationId:string):string[] {
  const rows=db.prepare(`SELECT f.reason FROM private_reply_feedback f JOIN private_conversations c ON c.id=f.conversation_id AND c.owner_user_id=f.owner_user_id AND c.status='active' JOIN private_messages m ON m.id=f.source_message_id AND m.conversation_id=f.conversation_id AND m.role='user' JOIN private_messages a ON a.id=f.assistant_message_id AND a.conversation_id=f.conversation_id AND a.role='assistant' WHERE f.owner_user_id=? AND f.conversation_id=? AND f.reason IS NOT NULL AND m.status='current' AND m.version=f.source_message_version AND a.status='current' AND a.version=f.assistant_message_version ORDER BY f.updated_at DESC,f.created_at DESC,f.rowid DESC`).all(userId,conversationId) as {reason:ReplyFeedbackReason}[];
  const seen=new Set<string>(),preferences:string[]=[];
  for(const {reason} of rows) { const item=RESPONSE_PREFERENCE_BY_REASON[reason]; if(item&&!seen.has(item.category)){seen.add(item.category);preferences.push(item.description);} }
  return preferences;
}

export function setLatestReplyFeedback(userId:string,conversationId:string,assistantMessageId:string,rating:ReplyFeedbackRating|null,reason:ReplyFeedbackReason|null,expectedVersion:number) {
  return db.transaction(()=>{
    const row=getOwnedConversation(userId,conversationId); if(!row)return {error:"not_found" as const};
    if(row.version!==expectedVersion)return {error:"stale" as const};
    const turn=latestTurnForMessages(listCurrentMessages(conversationId));
    if(turn.assistantMessageId!==assistantMessageId||!turn.userMessageId)return {error:"not_latest" as const};
    if(!isValidReplyFeedback(rating,reason))return {error:"invalid_feedback" as const};
    if(rating===null) db.prepare(`DELETE FROM private_reply_feedback WHERE owner_user_id=? AND conversation_id=? AND assistant_message_id=?`).run(userId,conversationId,assistantMessageId);
    else {
      const timestamp=now(),source=db.prepare(`SELECT version FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(turn.userMessageId,conversationId) as {version:number};
      const assistant=db.prepare(`SELECT version FROM private_messages WHERE id=? AND conversation_id=? AND role='assistant' AND status='current'`).get(assistantMessageId,conversationId) as {version:number};
      db.prepare(`INSERT INTO private_reply_feedback(owner_user_id,conversation_id,source_message_id,source_message_version,assistant_message_id,assistant_message_version,rating,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,conversation_id,assistant_message_id) DO UPDATE SET source_message_id=excluded.source_message_id,source_message_version=excluded.source_message_version,assistant_message_version=excluded.assistant_message_version,rating=excluded.rating,reason=excluded.reason,updated_at=excluded.updated_at`).run(userId,conversationId,turn.userMessageId,source.version,assistantMessageId,assistant.version,rating,reason,timestamp,timestamp);
    }
    const feedback=rating===null?null:{rating,reason};
    return {feedback,responsePreferences:listResponsePreferences(userId,conversationId)};
  }).immediate();
}

export function clearConversationResponsePreferences(userId:string,conversationId:string,expectedVersion:number) {
  return db.transaction(()=>{
    const row=getOwnedConversation(userId,conversationId); if(!row)return {error:"not_found" as const};
    if(row.version!==expectedVersion)return {error:"stale" as const};
    db.prepare(`DELETE FROM private_reply_feedback WHERE owner_user_id=? AND conversation_id=?`).run(userId,conversationId);
    return {feedback:null,responsePreferences:[] as string[]};
  }).immediate();
}

export function getReplyContext(conversationId:string):{history:PrivateMessage[];notes:PrivateNote[]} {
  const messages=listCurrentMessages(conversationId);
  const recent=messages.slice(-12);
  const notes=listCurrentNotes(conversationId);
  const recentIds=new Set(recent.map(item=>item.id));
  // Source IDs establish provenance, not full-message coverage. A note may omit
  // details from a source message, so retain older user messages in raw context.
  const olderUserMessages=messages.filter(item=>item.role==="user"&&!recentIds.has(item.id));
  return {history:[...olderUserMessages,...recent].sort((a,b)=>a.createdAt-b.createdAt),notes};
}

function newJob(userId: string, conversationId: string, kind: PrivateJobKind, version: number, sourceMessageId: string | null, sourceMessageVersion: number | null, payload: unknown = {}): PrivateJob {
  const timestamp = now(); const jobId = id();
  db.prepare(`INSERT INTO private_jobs(id,owner_user_id,conversation_id,kind,input_version,source_message_id,source_message_version,payload,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, 'queued',?,?)`).run(jobId,userId,conversationId,kind,version,sourceMessageId,sourceMessageVersion,JSON.stringify(payload),timestamp,timestamp);
  bindTwoCallPrivateJob(jobId);
  return getPrivateJob(userId, conversationId, jobId)!;
}

export function getPrivateJob(userId: string, conversationId: string, jobId: string): PrivateJob | null {
  const row = db.prepare(`SELECT * FROM private_jobs WHERE id=? AND owner_user_id=? AND conversation_id=?`).get(jobId,userId,conversationId) as JobRow | undefined;
  return row ? job(row) : null;
}

export function getJobForSource(userId:string,conversationId:string,messageId:string):PrivateJob|null {
  const row=db.prepare(`SELECT * FROM private_jobs WHERE owner_user_id=? AND conversation_id=? AND source_message_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(userId,conversationId,messageId) as JobRow|undefined;
  return row?job(row):null;
}

export function getJobMessage(userId: string, conversationId: string, jobId: string): PrivateMessage | null {
  const row = db.prepare(`SELECT m.* FROM private_jobs j JOIN private_messages m ON m.id=j.result_message_id
    WHERE j.id=? AND j.owner_user_id=? AND j.conversation_id=? AND j.status='completed'`).get(jobId,userId,conversationId) as MessageRow | undefined;
  return row ? message(row) : null;
}

export function addUserMessage(userId: string, conversationId: string, content: string, requestId?: string) {
  const row = getOwnedConversation(userId, conversationId); if (!row) return null;
  if (requestId) {
    const existing = db.prepare(`SELECT * FROM private_messages WHERE conversation_id=? AND client_request_id=?`).get(conversationId,requestId) as MessageRow | undefined;
    if (existing) return { message: message(existing), jobId: null, conversationVersion: row.version };
  }
  const timestamp = now(); const msgId = id();
  const { version, jobId } = db.transaction(() => {
    const nextVersion = row.version + 1;
    db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE conversation_id=? AND status IN ('queued','processing')`).run(timestamp,conversationId);
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at,client_request_id) VALUES(?,?,'user',?,1,'current',?,?)`).run(msgId,conversationId,content,timestamp,requestId ?? null);
    markPrivateMemorySourceChanged(userId);
    applyNaturalMemoryCorrection(userId, conversationId, msgId, 1, content);
    db.prepare(`UPDATE private_conversations SET version=?,updated_at=?,last_message_at=? WHERE id=? AND owner_user_id=?`).run(nextVersion,timestamp,timestamp,conversationId,userId);
    refreshPrivateRisk(conversationId);
    const queued = newJob(userId,conversationId,"reply",nextVersion,msgId,1,{});
    return { version: nextVersion, jobId: queued.id };
  })();
  return { message: { id: msgId, role: "user" as const, content, version: 1, createdAt: timestamp, status: "current" as const }, jobId, conversationVersion: version };
}

export function editUserMessage(userId: string, conversationId: string, messageId: string, content: string, expectedVersion: number) {
  return db.transaction(() => {
    const row = getOwnedConversation(userId,conversationId); if (!row) return { error: "not_found" as const };
    if (row.version !== expectedVersion) return { error: "stale" as const };
    const target = db.prepare(`SELECT *,rowid AS sequence FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(messageId,conversationId) as (MessageRow & {sequence:number}) | undefined;
    if (!target) return { error: "not_found" as const };
    if(latestTurnForMessages(listCurrentMessages(conversationId)).userMessageId!==messageId)return {error:"not_latest" as const};
    const timestamp=now(); const newVersion=row.version+1;
    db.prepare(`UPDATE private_messages SET content=?,version=version+1 WHERE id=?`).run(content,messageId);
    markPrivateMemorySourceChanged(userId);
    db.prepare(`UPDATE private_messages SET status='superseded' WHERE conversation_id=? AND role='assistant' AND rowid>?`).run(conversationId,target.sequence);
    db.prepare(`DELETE FROM private_reply_feedback WHERE owner_user_id=? AND conversation_id=? AND source_message_id=?`).run(userId,conversationId,messageId);
    db.prepare(`UPDATE private_notes SET status='stale',version=version+1,updated_at=? WHERE conversation_id=? AND source_message_ids LIKE ?`).run(timestamp,conversationId,`%${messageId}%`);
    invalidatePrivateMemorySource(userId,conversationId,messageId);
    db.prepare(`UPDATE private_share_drafts SET status='cancelled',updated_at=? WHERE conversation_id=? AND status='draft' AND event_id IS NULL AND source_message_ids LIKE ?`).run(timestamp,conversationId,`%\"${messageId}\"%`);
    db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE conversation_id=? AND status IN ('queued','processing')`).run(timestamp,conversationId);
    db.prepare(`UPDATE private_conversations SET version=?,updated_at=?,last_message_at=? WHERE id=?`).run(newVersion,timestamp,timestamp,conversationId);
    refreshPrivateRisk(conversationId);
    const updated=db.prepare(`SELECT * FROM private_messages WHERE id=?`).get(messageId) as MessageRow;
    applyNaturalMemoryCorrection(userId, conversationId, updated.id, updated.version, updated.content);
    const queued=newJob(userId,conversationId,"reply",newVersion,messageId,updated.version,{});
    return { message: message(updated), jobId: queued.id, conversationVersion: newVersion };
  }).immediate();
}

export function deleteUserMessage(userId: string, conversationId: string, messageId: string, expectedVersion: number): "ok" | "stale" | "not_latest" | "not_found" {
  return db.transaction(()=>{
    const row=getOwnedConversation(userId,conversationId); if(!row) return "not_found"; if(row.version!==expectedVersion) return "stale";
    const target=db.prepare(`SELECT *,rowid AS sequence FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(messageId,conversationId) as (MessageRow & {sequence:number})|undefined;
    if(!target) return "not_found";
    if(latestTurnForMessages(listCurrentMessages(conversationId)).userMessageId!==messageId)return "not_latest";
    const timestamp=now();
    db.prepare(`DELETE FROM private_messages WHERE id=?`).run(messageId);
    markPrivateMemorySourceChanged(userId);
    db.prepare(`DELETE FROM private_messages WHERE conversation_id=? AND role='assistant' AND rowid>?`).run(conversationId,target.sequence);
    db.prepare(`DELETE FROM private_reply_feedback WHERE owner_user_id=? AND conversation_id=? AND source_message_id=?`).run(userId,conversationId,messageId);
    db.prepare(`DELETE FROM private_notes WHERE conversation_id=? AND source_message_ids LIKE ?`).run(conversationId,`%\"${messageId}\"%`);
    invalidatePrivateMemorySource(userId,conversationId,messageId);
    db.prepare(`DELETE FROM private_share_drafts WHERE conversation_id=? AND event_id IS NULL AND source_message_ids LIKE ?`).run(conversationId,`%\"${messageId}\"%`);
    db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE conversation_id=? AND status IN ('queued','processing')`).run(timestamp,conversationId);
    db.prepare(`UPDATE private_conversations SET version=version+1,updated_at=?,last_message_at=? WHERE id=?`).run(timestamp,timestamp,conversationId);
    refreshPrivateRisk(conversationId);
    return "ok";
  }).immediate();
}

export function listCurrentMessages(conversationId: string): PrivateMessage[] {
  return (db.prepare(`SELECT * FROM private_messages WHERE conversation_id=? AND status='current' ORDER BY created_at,rowid`).all(conversationId) as MessageRow[]).map(message);
}

export function listCurrentNotes(conversationId: string): PrivateNote[] {
  return (db.prepare(`SELECT * FROM private_notes WHERE conversation_id=? AND status IN ('current','corrected') ORDER BY updated_at DESC`).all(conversationId) as NoteRow[]).filter(noteSourcesAreCurrent).map(note);
}

export function createNotesJob(userId: string, conversationId: string) {
  return db.transaction(()=>{
    const row=getOwnedConversation(userId,conversationId); if(!row) return null;
    const active=db.prepare(`SELECT * FROM private_jobs WHERE owner_user_id=? AND conversation_id=? AND kind='notes' AND input_version=? AND status IN ('queued','processing') ORDER BY created_at,rowid LIMIT 1`).get(userId,conversationId,row.version) as JobRow|undefined;
    if(active)return job(active);
    const messages=listCurrentMessages(conversationId).filter(m=>m.role==="user");
    return newJob(userId,conversationId,"notes",row.version,null,null,{ messageIds: messages.map(m=>m.id), messageVersions:Object.fromEntries(messages.map(m=>[m.id,m.version])) });
  })();
}

export function createShareDraftJob(userId: string, conversationId: string, sourceMessageIds: string[]) {
  return db.transaction(()=>{
    const row=getOwnedConversation(userId,conversationId); if(!row) return null;
    if(conversationHasActiveRisk(userId,conversationId))return false;
    const selected=db.prepare(`SELECT id,version FROM private_messages WHERE conversation_id=? AND role='user' AND status='current' AND id IN (${sourceMessageIds.map(()=>"?").join(",") || "NULL"})`).all(conversationId,...sourceMessageIds) as {id:string;version:number}[];
    if(!sourceMessageIds.length || selected.length!==new Set(sourceMessageIds).size) return false;
    const draftId=id(); const timestamp=now();
    db.prepare(`INSERT INTO private_share_drafts(id,conversation_id,content,source_message_ids,version,status,created_at,updated_at) VALUES(?,?, '', ?,1,'draft',?,?)`).run(draftId,conversationId,JSON.stringify(sourceMessageIds),timestamp,timestamp);
    const queued=newJob(userId,conversationId,"share_draft",row.version,null,null,{draftId,draftVersion:1,sourceMessageIds,sourceMessageVersions:Object.fromEntries(selected.map(x=>[x.id,x.version]))});
    return { draftId, jobId: queued.id };
  }).immediate();
}

export function patchShareDraft(userId:string,conversationId:string,draftId:string,content:string,expectedVersion:number) {
  const row=db.prepare(`SELECT d.* FROM private_share_drafts d JOIN private_conversations c ON c.id=d.conversation_id WHERE d.id=? AND d.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(draftId,conversationId,userId) as DraftRow|undefined;
  if(!row) return {error:"not_found" as const}; if(row.version!==expectedVersion||row.status!=="draft") return {error:"stale" as const};
  const timestamp=now(); const changed=db.prepare(`UPDATE private_share_drafts SET content=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='draft'`).run(content,timestamp,draftId,expectedVersion);
  if(!changed.changes) return {error:"stale" as const};
  return {draft: draft(db.prepare(`SELECT * FROM private_share_drafts WHERE id=?`).get(draftId) as DraftRow)};
}

export function getShareDraft(userId:string,conversationId:string,draftId:string):ShareDraft|null {
  const row=db.prepare(`SELECT d.* FROM private_share_drafts d JOIN private_conversations c ON c.id=d.conversation_id WHERE d.id=? AND d.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(draftId,conversationId,userId) as DraftRow|undefined;
  return row?draft(row):null;
}

export function getShareDraftSources(conversationId:string, messageIds:string[]) {
  if(!messageIds.length) return [];
  return db.prepare(`SELECT id,role,content,version FROM private_messages WHERE conversation_id=? AND role='user' AND status='current' AND id IN (${messageIds.map(()=>"?").join(",")}) ORDER BY created_at,rowid`).all(conversationId,...messageIds) as {id:string;role:"user";content:string;version:number}[];
}

export function completePrivateJob(jobId:string, result:unknown, memorySnapshot?:MemoryReplySnapshot):boolean {
  const row=db.prepare(`SELECT * FROM private_jobs WHERE id=? AND status='processing'`).get(jobId) as JobRow|undefined;
  if(!row) return false;
  const conv=getOwnedConversation(row.owner_user_id,row.conversation_id);
  if(!conv || conv.version!==row.input_version) return cancelPrivateJobWrite(jobId);
  const timestamp=now();
  const payload=JSON.parse(row.payload) as {draftId?:string;draftVersion?:number;sourceMessageIds?:string[];sourceMessageVersions?:Record<string,number>;messageIds?:string[];messageVersions?:Record<string,number>};
  if(row.kind==="reply") {
    const source=row.source_message_id?db.prepare(`SELECT * FROM private_messages WHERE id=? AND conversation_id=? AND status='current'`).get(row.source_message_id,row.conversation_id) as MessageRow|undefined:undefined;
    if(!source || source.version!==row.source_message_version) return cancelPrivateJobWrite(jobId);
      const reply=String((result as {reply?:unknown})?.reply??"").trim(); if(!reply) return failPrivateJobInner(jobId,"EMPTY_RESULT");
      const isSafetyResponse=(result as {safetyResponse?:unknown})?.safetyResponse===true?1:0;
      const committed=db.transaction(()=>{
        if(memorySnapshot&&!privateMemorySnapshotStillCurrent(row.owner_user_id,memorySnapshot)) {
          db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='processing'`).run(timestamp,jobId);
          return false;
        }
        const replyId=id();
        db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at,is_safety_response) VALUES(?,?,'assistant',?,1,'current',?,?)`).run(replyId,row.conversation_id,reply,timestamp,isSafetyResponse);
      db.prepare(`UPDATE private_conversations SET updated_at=?,last_message_at=?,version=version+1 WHERE id=?`).run(timestamp,timestamp,row.conversation_id);
      db.prepare(`UPDATE private_jobs SET status='completed',result_message_id=?,updated_at=? WHERE id=? AND status='processing'`).run(replyId,timestamp,jobId);
      const updated=db.prepare(`SELECT version FROM private_conversations WHERE id=?`).get(row.conversation_id) as {version:number};
      newJob(row.owner_user_id,row.conversation_id,"notes",updated.version,null,null,{messageIds:listCurrentMessages(row.conversation_id).filter(m=>m.role==="user").map(m=>m.id)});
      completeTwoCallJob(jobId);
    return true;
      }).immediate(); return committed;
  }
  if(row.kind==="share_draft") {
    const sources=payload.sourceMessageIds??[];
    const stillCurrent=sources.length && sources.every((messageId)=>{
      const msg=db.prepare(`SELECT version,status FROM private_messages WHERE id=? AND conversation_id=?`).get(messageId,row.conversation_id) as {version:number;status:string}|undefined;
      return msg?.status==="current" && msg.version===payload.sourceMessageVersions?.[messageId];
    });
    const currentDraft=payload.draftId?db.prepare(`SELECT version,status FROM private_share_drafts WHERE id=?`).get(payload.draftId) as {version:number;status:string}|undefined:undefined;
    const content=String((result as {content?:unknown})?.content??"").trim();
    if(!stillCurrent||!content||currentDraft?.status!=="draft"||currentDraft.version!==payload.draftVersion) return cancelPrivateJobWrite(jobId);
    db.transaction(()=>{
      db.prepare(`UPDATE private_share_drafts SET content=?,updated_at=? WHERE id=? AND status='draft'`).run(content,timestamp,payload.draftId);
      db.prepare(`UPDATE private_jobs SET status='completed',updated_at=? WHERE id=? AND status='processing'`).run(timestamp,jobId);
    })(); return true;
  }
  const notes=Array.isArray(result)?result as {kind:PrivateNote["kind"];content:string;sourceMessageIds:string[]}[]:[];
  db.transaction(()=>{
    db.prepare(`UPDATE private_notes SET status='stale',version=version+1,updated_at=? WHERE conversation_id=? AND status='current'`).run(timestamp,row.conversation_id);
    for(const item of notes) {
      const sources=[...new Set(item.sourceMessageIds)].filter(messageId=>{
        return !!db.prepare(`SELECT 1 FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(messageId,row.conversation_id);
      });
      if(!sources.length||!item.content?.trim()||!(["user_statement","tentative_understanding","unknown"] as string[]).includes(item.kind)) continue;
      const sourceVersions=Object.fromEntries(sources.map(messageId=>{const m=db.prepare(`SELECT version FROM private_messages WHERE id=?`).get(messageId) as {version:number};return [messageId,m.version]}));
      const existing=db.prepare(`SELECT id,version FROM private_notes WHERE conversation_id=? AND kind=? AND content=? AND status='current'`).get(row.conversation_id,item.kind,item.content) as {id:string;version:number}|undefined;
      const noteId=existing?.id??id();
      db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'current',?) ON CONFLICT(id) DO UPDATE SET source_message_ids=excluded.source_message_ids,source_message_versions=excluded.source_message_versions,source_conversation_version=excluded.source_conversation_version,version=private_notes.version+1,status='current',updated_at=excluded.updated_at`)
        .run(noteId,row.conversation_id,item.kind,item.content,JSON.stringify(sources),JSON.stringify(sourceVersions),row.input_version,existing?existing.version+1:1,timestamp);
    }
    const currentNotes=db.prepare(`SELECT id,kind,content,correction,source_message_ids AS sourceMessageIds,source_message_versions AS sourceMessageVersions,status,version FROM private_notes WHERE conversation_id=? AND status IN ('current','corrected')`)
      .all(row.conversation_id) as Array<{id:string;kind:PrivateNote["kind"];content:string;correction:string|null;sourceMessageIds:string;sourceMessageVersions:string;status:string;version:number}>;
    syncPrivateMemoryFromNotes(row.owner_user_id,row.conversation_id,currentNotes);
    db.prepare(`UPDATE private_jobs SET status='completed',updated_at=? WHERE id=? AND status='processing'`).run(timestamp,jobId);
    completeNotesDispatchJob(jobId);
  })(); return true;
}

function cancelPrivateJobWrite(jobId:string):false {
  db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='processing'`).run(now(),jobId); return false;
}
export function failPrivateJob(jobId:string,errorCode="AI_UNAVAILABLE"):void {
  stopTwoCallJob(jobId,errorCode);
  stopNotesDispatchJob(jobId,errorCode);
  failPrivateJobInner(jobId,errorCode);
}
function failPrivateJobInner(jobId:string,errorCode:string):false { db.prepare(`UPDATE private_jobs SET status='failed',error_code=?,updated_at=? WHERE id=? AND status='processing'`).run(errorCode,now(),jobId); return false; }
export function cancelPrivateJobWork(jobId:string):void { stopTwoCallJob(jobId,"JOB_CANCELLED"); stopNotesDispatchJob(jobId,"JOB_CANCELLED"); cancelPrivateJobWrite(jobId); }

export function requeueInterruptedPrivateJobs():number {
  recoverInterruptedNotesDispatch();
  // ponytail: restart assumes one backend worker process per SQLite database; use expiring per-worker leases if deployments add replicas.
  const guard=getTwoCallGuardState();
  if(guard?.phases.length && guard.job_id && (db.prepare("SELECT status FROM private_jobs WHERE id=?").get(guard.job_id) as {status:string}|undefined)?.status==="processing") {
    if(guard.job_id) { stopTwoCallJob(guard.job_id,"INTERRUPTED_RESERVED_REQUEST"); db.prepare("UPDATE private_jobs SET status='failed',error_code='BATCH_STOPPED',updated_at=? WHERE id=? AND status='processing'").run(now(),guard.job_id); }
  }
  return db.prepare(`UPDATE private_jobs SET status='queued',updated_at=? WHERE status='processing'`).run(now()).changes;
}

export type PrivateJobLane="foreground"|"background";

function privateJobEligible(job:JobRow):boolean {
  return notesDispatchGuardConfigured() ? notesPrivateJobEligible(job) : twoCallPrivateJobEligible(job);
}

export function claimPrivateJob(lane?:PrivateJobLane):PrivateJob & {ownerUserId:string;conversationId:string;sourceMessageId:string|null;sourceMessageVersion:number|null;payload:unknown}|undefined {
  return db.transaction(()=>{
    while(true) {
      const laneFilter=lane==="foreground"?` AND kind IN ('reply','share_draft')`:lane==="background"?` AND kind='notes'`:"";
      const row=(db.prepare(`SELECT * FROM private_jobs WHERE status='queued'${laneFilter} ORDER BY created_at,rowid`).all() as JobRow[]).find(privateJobEligible);
      if(!row) return undefined;
      const conv=getOwnedConversation(row.owner_user_id,row.conversation_id);
      let current=!!conv&&conv.version===row.input_version;
      const payload=JSON.parse(row.payload) as {draftId?:string;draftVersion?:number;sourceMessageIds?:string[];sourceMessageVersions?:Record<string,number>;messageVersions?:Record<string,number>};
      if(current&&row.kind==="reply") {
        const source=row.source_message_id?db.prepare(`SELECT version FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(row.source_message_id,row.conversation_id) as {version:number}|undefined:undefined;
        current=!!source&&source.version===row.source_message_version;
      } else if(current&&row.kind==="share_draft") {
        const draftRow=payload.draftId?db.prepare(`SELECT version,status FROM private_share_drafts WHERE id=? AND conversation_id=?`).get(payload.draftId,row.conversation_id) as {version:number;status:string}|undefined:undefined;
        current=!!draftRow&&draftRow.status==="draft"&&draftRow.version===payload.draftVersion&&(payload.sourceMessageIds??[]).length>0&&(payload.sourceMessageIds??[]).every(messageId=>{
          const source=db.prepare(`SELECT version FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(messageId,row.conversation_id) as {version:number}|undefined;
          return !!source&&source.version===payload.sourceMessageVersions?.[messageId];
        });
      } else if(current&&row.kind==="notes"&&payload.messageVersions) {
        current=Object.entries(payload.messageVersions).every(([messageId,version])=>{
          const source=db.prepare(`SELECT version FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(messageId,row.conversation_id) as {version:number}|undefined;
          return !!source&&source.version===version;
        });
      }
      if(!current) {
        db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='queued'`).run(now(),row.id);
        continue;
      }
      const timestamp=now();
      const result=db.prepare(`UPDATE private_jobs SET status='processing',updated_at=? WHERE id=? AND status='queued'`).run(timestamp,row.id);
      if(!result.changes) continue;
      const updated={...row,status:"processing" as const,updated_at:timestamp};
      return {...job(updated),ownerUserId:row.owner_user_id,conversationId:row.conversation_id,sourceMessageId:row.source_message_id,sourceMessageVersion:row.source_message_version,payload};
    }
  })();
}

export function privateJobsQueued(lane?:PrivateJobLane):boolean {
  const laneFilter=lane==="foreground"?` AND kind IN ('reply','share_draft')`:lane==="background"?` AND kind='notes'`:"";
  return (db.prepare(`SELECT * FROM private_jobs WHERE status='queued'${laneFilter}`).all() as JobRow[]).some(privateJobEligible);
}

export function cancelJob(userId:string,conversationId:string,jobId:string):PrivateJob|null {
  const timestamp=now();
  db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE id=? AND owner_user_id=? AND conversation_id=? AND status IN ('queued','processing')`).run(timestamp,jobId,userId,conversationId);
  return getPrivateJob(userId,conversationId,jobId);
}

export function retryJob(userId:string,conversationId:string,jobId:string):PrivateJob|null {
  return db.transaction(()=>{
    const old=db.prepare(`SELECT * FROM private_jobs WHERE id=? AND owner_user_id=? AND conversation_id=? AND status='failed'`).get(jobId,userId,conversationId) as JobRow|undefined;
    const conv=getOwnedConversation(userId,conversationId);
    if(!old||!conv||old.input_version!==conv.version || notesDispatchGuardConfigured() || twoCallGuardConfigured()) return null;
    const existing=db.prepare(`SELECT * FROM private_jobs WHERE owner_user_id=? AND conversation_id=? AND kind=? AND input_version=? AND source_message_id IS ? AND payload=? AND status IN ('queued','processing','completed') ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .get(userId,conversationId,old.kind,old.input_version,old.source_message_id,old.payload) as JobRow|undefined;
    if(existing)return job(existing);
    const created=newJob(userId,conversationId,old.kind,old.input_version,old.source_message_id,old.source_message_version,JSON.parse(old.payload));
    return created;
  })();
}

export function cancelAllConversationJobs(conversationId:string):void {
  db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE conversation_id=? AND status IN ('queued','processing')`).run(now(),conversationId);
}

export function deleteConversation(userId:string,conversationId:string):boolean {
  return db.transaction(()=>{
    const row=getOwnedConversation(userId,conversationId); if(!row) return false;
    invalidatePrivateMemorySource(userId,conversationId);
    cancelAllConversationJobs(conversationId);
    db.prepare(`DELETE FROM private_messages WHERE conversation_id=?`).run(conversationId);
    db.prepare(`DELETE FROM private_reply_feedback WHERE owner_user_id=? AND conversation_id=?`).run(userId,conversationId);
    db.prepare(`DELETE FROM private_notes WHERE conversation_id=?`).run(conversationId);
    db.prepare(`DELETE FROM private_risk_state WHERE conversation_id=?`).run(conversationId);
    db.prepare(`DELETE FROM private_share_drafts WHERE conversation_id=? AND event_id IS NULL`).run(conversationId);
    db.prepare(`DELETE FROM private_jobs WHERE conversation_id=?`).run(conversationId);
    db.prepare(`DELETE FROM analytics_events WHERE user_id=? AND event_id=?`).run(userId,conversationId);
    db.prepare(`DELETE FROM ai_call_metrics WHERE analytics_conversation_id=?`).run(conversationId);
    db.prepare(`UPDATE events SET a_conversation_id=NULL WHERE a_conversation_id=?`).run(conversationId);
    db.prepare(`UPDATE events SET b_conversation_id=NULL WHERE b_conversation_id=?`).run(conversationId);
    db.prepare(`UPDATE private_conversations SET status='deleted',title='',updated_at=?,version=version+1 WHERE id=? AND owner_user_id=?`).run(now(),conversationId,userId);
    return true;
  })();
}

function noteSourcesAreCurrent(row:NoteRow):boolean {
  try {
    const sourceIds=JSON.parse(row.source_message_ids) as unknown;
    const sourceVersions=JSON.parse(row.source_message_versions) as unknown;
    if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.some(id=>typeof id!=="string")||new Set(sourceIds).size!==sourceIds.length||!sourceVersions||typeof sourceVersions!=="object"||Array.isArray(sourceVersions))return false;
    const versions=sourceVersions as Record<string,unknown>;
    if(Object.keys(versions).length!==sourceIds.length||sourceIds.some(id=>!Number.isInteger(versions[id])))return false;
    const sources=db.prepare(`SELECT id,version FROM private_messages WHERE conversation_id=? AND role='user' AND status='current' AND id IN (${sourceIds.map(()=>"?").join(",")})`).all(row.conversation_id,...sourceIds) as {id:string;version:number}[];
    return sources.length===sourceIds.length&&sources.every(source=>source.version===versions[source.id]);
  } catch { return false; }
}

export function correctNote(userId:string,conversationId:string,noteId:string,correction:string,expectedVersion:number) {
  if(!correction.trim()) return {error:"empty_correction" as const};
  const row=db.prepare(`SELECT n.* FROM private_notes n JOIN private_conversations c ON c.id=n.conversation_id WHERE n.id=? AND n.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(noteId,conversationId,userId) as NoteRow|undefined;
  if(!row) return {error:"not_found" as const}; if(row.version!==expectedVersion) return {error:"stale" as const};
  if(!(row.status==="current"||row.status==="corrected")||!noteSourcesAreCurrent(row))return {error:"stale" as const};
  const timestamp=now();
  const result=db.transaction(()=>{
    const updated=db.prepare(`UPDATE private_notes SET correction=?,status='corrected',version=version+1,updated_at=? WHERE id=? AND version=? AND status IN ('current','corrected')`).run(correction,timestamp,noteId,expectedVersion);
    if(updated.changes) {
      db.prepare(`UPDATE private_conversations SET version=version+1,updated_at=? WHERE id=?`).run(timestamp,conversationId);
      db.prepare(`UPDATE private_jobs SET status='cancelled',updated_at=? WHERE conversation_id=? AND status IN ('queued','processing')`).run(timestamp,conversationId);
    }
    return updated;
  })();
  if(!result.changes) return {error:"stale" as const};
  syncCorrectedNoteToMemory(userId,noteId,correction.trim());
  return {note:note(db.prepare(`SELECT * FROM private_notes WHERE id=?`).get(noteId) as NoteRow)};
}

export function confirmShareDraft(userId:string,conversationId:string,draftId:string,version:number) {
  const row=db.prepare(`SELECT d.* FROM private_share_drafts d JOIN private_conversations c ON c.id=d.conversation_id WHERE d.id=? AND d.conversation_id=? AND c.owner_user_id=? AND c.status='active'`).get(draftId,conversationId,userId) as DraftRow|undefined;
  if(!row) return {error:"not_found" as const};
  if(row.status==="converted"&&row.version===version&&row.event_id) {
    // Older deleted events may have left an orphaned draft. Never return a
    // nonexistent event or silently recreate it through a retry of that share.
    return getEvent(row.event_id) ? {eventId:row.event_id,shareVersion:version,inviteStatus:"pending" as const} : {error:"stale" as const};
  }
  if(row.version!==version||row.status!=="draft") return {error:"stale" as const};
  if(conversationHasActiveRisk(userId,conversationId))return {error:"active_risk" as const};
  if(!row.content.trim()) return {error:"empty_draft" as const};
  const linkedConversation=getOwnedConversation(userId,conversationId);
  if(!linkedConversation) return {error:"not_found" as const};
  const sources=JSON.parse(row.source_message_ids) as string[];
  const currentSources=sources.length?db.prepare(`SELECT id FROM private_messages WHERE conversation_id=? AND role='user' AND status='current' AND id IN (${sources.map(()=>"?").join(",")})`).all(conversationId,...sources) as {id:string}[]:[];
  if(currentSources.length!==new Set(sources).size) return {error:"stale" as const};
  if(linkedConversation.linked_side==="b"&&linkedConversation.linked_event_id&&getEvent(linkedConversation.linked_event_id)) {
    return db.transaction(()=>{
      const current=db.prepare(`SELECT version,status FROM private_share_drafts WHERE id=?`).get(draftId) as {version:number;status:string}|undefined;
      if(current?.status==="converted"&&current.version===version) return getEvent(linkedConversation.linked_event_id!) ? {eventId:linkedConversation.linked_event_id!,shareVersion:version,inviteStatus:"pending" as const} : {error:"stale" as const};
      if(!current||current.version!==version||current.status!=="draft")return {error:"stale" as const};
      const event=getEvent(linkedConversation.linked_event_id!);
      if(!event||event.b_user_id!==userId||event.state!=="b_guiding")return {error:"wrong_state" as const};
      if(event.risk_level!=="none"||eventHasActivePrivateRisk(event.id))return {error:"active_risk" as const};
      if(!transition(event.id,"b_guiding","b_summary"))return {error:"wrong_state" as const};
      if(!getPerspective(event.id,"b"))upsertPerspective(event.id,"b","");
      setSummary(event.id,"b",JSON.stringify({format:"confirmed_plain_text",observation:row.content,feelings:[],needs:[],request:""}));
      confirmSummary(event.id,"b");
      const mergeJob=enqueueAiJob(event.id,"merge_initial","b");
      db.prepare(`UPDATE private_share_drafts SET status='converted',event_id=?,updated_at=? WHERE id=? AND version=?`).run(event.id,now(),draftId,version);
      return {eventId:event.id,shareVersion:version,inviteStatus:"pending" as const};
    }).immediate();
  }
  const partnerId=getActivePartnerUserId(userId); if(!partnerId) return {error:"partner_binding_required" as const};
  return db.transaction(()=>{
    const current=db.prepare(`SELECT version,status FROM private_share_drafts WHERE id=?`).get(draftId) as {version:number;status:string};
    if(current.version!==version||current.status!=="draft") return {error:"stale" as const};
    const event=createEvent("按本人确认的内容发起复盘",userId);
    if(!getPerspective(event.id,"a"))upsertPerspective(event.id,"a","");
    setSummary(event.id,"a",JSON.stringify({format:"confirmed_plain_text",observation:row.content,feelings:[],needs:[],request:""}));
    confirmSummary(event.id,"a");
    if(!transition(event.id,"a_guiding","a_summary")||!transition(event.id,"a_summary","waiting_b")) throw new Error("event state conflict");
    const target=targetActivePartnerForEvent(event.id,userId);
    if(target!==partnerId) { throw new Error("partner binding changed"); }
    db.prepare(`UPDATE private_conversations SET linked_event_id=?,linked_side='a',updated_at=? WHERE id=?`).run(event.id,now(),conversationId);
    db.prepare(`UPDATE events SET a_conversation_id=?,a_share_version=? WHERE id=?`).run(conversationId,version,event.id);
    db.prepare(`UPDATE private_share_drafts SET status='converted',event_id=?,updated_at=? WHERE id=? AND version=?`).run(event.id,now(),draftId,version);
    return {eventId:event.id,shareVersion:version,inviteStatus:"pending" as const};
  })();
}

export function getOrCreateEventConversation(userId:string,eventId:string,side:"a"|"b"):PrivateConversation|null {
  const column=side==="a"?"a_conversation_id":"b_conversation_id";
  const event=db.prepare(`SELECT * FROM events WHERE id=? AND ${side}_user_id=?`).get(eventId,userId) as {id:string;[key:string]:unknown}|undefined;
  if(!event) return null;
  const linked=event[column];
  if(typeof linked==="string") {
    const existing=getConversationById(userId,linked);
    if(existing) return existing;
  }
  const created=createConversation(userId,"复盘中的私密表达",{eventId,side});
  return created;
}

export function confirmEventSummary(userId:string,conversationId:string,content:string,expectedVersion:number):"ok"|"not_found"|"stale"|"wrong_state"|"active_risk" {
  return db.transaction(()=>{
    const conv=getOwnedConversation(userId,conversationId); if(!conv||conv.linked_side!=="b"||!conv.linked_event_id)return "not_found";
    if(conversationHasActiveRisk(userId,conversationId))return "active_risk";
    if(conv.version!==expectedVersion)return "stale";
    const event=getEvent(conv.linked_event_id);
    if(!event||event.b_user_id!==userId)return "wrong_state";
    if(event.risk_level!=="none"||eventHasActivePrivateRisk(event.id))return "active_risk";
    if(!(["b_guiding","b_summary"] as string[]).includes(event.state))return "wrong_state";
    if(event.state==="b_summary") {
      if(event.b_conversation_id!==conversationId)return "wrong_state";
      const a=getPerspective(event.id,"a"), b=getPerspective(event.id,"b");
      if(!a?.summary||a.summary_confirmed!==1||!b?.summary||b.summary_confirmed!==1)return "wrong_state";
      const existing=db.prepare(`SELECT 1 FROM ai_jobs WHERE event_id=? AND kind IN ('merge_initial','merge_correction') LIMIT 1`).get(event.id);
      if(!existing)enqueueAiJob(event.id,"merge_initial","b");
      return "ok";
    }
    if(!transition(event.id,"b_guiding","b_summary"))return "wrong_state";
    if(!getPerspective(event.id,"b"))upsertPerspective(event.id,"b","");
    const summary=JSON.stringify({format:"confirmed_plain_text",observation:content,feelings:[],needs:[],request:""});
    setSummary(event.id,"b",summary); confirmSummary(event.id,"b");
    enqueueAiJob(event.id,"merge_initial","b");
    return "ok";
  }).immediate();
}

export function markAnalyticsNoticeSeen(userId:string):void { db.prepare(`UPDATE users SET analytics_notice_seen=1 WHERE id=?`).run(userId); }
export function setAnalyticsPreference(userId:string,enabled:boolean):void {
  db.transaction(()=>{
    db.prepare(`UPDATE users SET analytics_enabled=?,analytics_notice_seen=1 WHERE id=?`).run(enabled?1:0,userId);
    if(!enabled) {
      db.prepare(`DELETE FROM analytics_events WHERE user_id=?`).run(userId);
      db.prepare(`DELETE FROM ai_call_metrics WHERE analytics_user_id=? OR analytics_event_id IN (SELECT id FROM events WHERE a_user_id=? OR b_user_id=?)`).run(userId,userId,userId);
    }
  })();
}
export function recordAnalytics(userId:string,sessionId:string,input:{name:string;eventId?:string;screen?:string;step?:string;result?:string;reason?:string;durationMs?:number}):boolean {
  const user=db.prepare(`SELECT analytics_enabled,analytics_notice_seen FROM users WHERE id=?`).get(userId) as {analytics_enabled:number;analytics_notice_seen:number}|undefined;
  if(!user?.analytics_enabled||!user.analytics_notice_seen) return false;
  if(input.eventId) {
    const event=db.prepare(`SELECT 1 FROM events WHERE id=? AND (a_user_id=? OR b_user_id=? OR partner_target_user_id=?)`).get(input.eventId,userId,userId,userId);
    const conv=db.prepare(`SELECT 1 FROM private_conversations WHERE id=? AND owner_user_id=? AND status='active'`).get(input.eventId,userId);
    if(!event&&!conv) return false;
  }
  pruneExpiredAnalytics();
  return db.prepare(`INSERT INTO analytics_events(user_id,session_id,event_id,name,screen,step,result,reason,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(userId,sessionId,input.eventId??null,input.name,input.screen??null,input.step??null,input.result??null,input.reason??null,input.durationMs??null,now()).changes>0;
}
export function getAnalyticsDashboard(days:7|30|90) {
  const since=now()-days*86400000;
  pruneExpiredAnalytics();
  const overview=db.prepare(`SELECT COUNT(DISTINCT user_id) users,COUNT(DISTINCT session_id) sessions,COUNT(*) events FROM analytics_events WHERE created_at>=?`).get(since) as {users:number;sessions:number;events:number};
  const funnel=db.prepare(`SELECT name,COUNT(*) count,COUNT(DISTINCT user_id) users FROM analytics_events WHERE created_at>=? GROUP BY name ORDER BY name`).all(since) as {name:string;count:number;users:number}[];
  const allowed=funnel.filter(x=>x.users>=5).map(({name,count,users})=>({name,count,users}));
  const lastSteps=db.prepare(`WITH ranked AS (SELECT user_id,session_id,COALESCE(step,screen,name) label,ROW_NUMBER() OVER(PARTITION BY session_id ORDER BY created_at DESC,id DESC) n FROM analytics_events WHERE created_at>=?) SELECT label,COUNT(*) sessions,COUNT(DISTINCT user_id) users FROM ranked WHERE n=1 GROUP BY label HAVING COUNT(DISTINCT user_id)>=5`).all(since);
  const feedbackReasons=db.prepare(`SELECT reason label,COUNT(*) count,COUNT(DISTINCT user_id) users FROM analytics_events WHERE created_at>=? AND name='message_feedback_submitted' AND reason IS NOT NULL GROUP BY reason HAVING COUNT(DISTINCT user_id)>=5`).all(since);
  const outcomes=db.prepare(`SELECT result label,COUNT(*) count,COUNT(DISTINCT user_id) users FROM analytics_events WHERE created_at>=? AND name='core_outcome_submitted' AND result IS NOT NULL GROUP BY result HAVING COUNT(DISTINCT user_id)>=5`).all(since);
  const modelRows=db.prepare(`SELECT m.*,e.a_user_id,e.b_user_id FROM ai_call_metrics m
    LEFT JOIN events e ON e.id=m.analytics_event_id
    LEFT JOIN users u ON u.id=m.analytics_user_id
    LEFT JOIN users a ON a.id=e.a_user_id
    LEFT JOIN users b ON b.id=e.b_user_id
    LEFT JOIN private_conversations c ON c.id=m.analytics_conversation_id
    WHERE m.created_at>=? AND (
      (m.analytics_event_id IS NULL AND m.analytics_user_id IS NOT NULL AND u.analytics_enabled=1 AND u.analytics_notice_seen=1
        AND (m.analytics_conversation_id IS NULL OR (c.id IS NOT NULL AND c.owner_user_id=m.analytics_user_id)))
      OR (m.analytics_event_id IS NOT NULL AND e.id IS NOT NULL AND a.analytics_enabled=1 AND a.analytics_notice_seen=1 AND b.analytics_enabled=1 AND b.analytics_notice_seen=1)
    )`).all(since) as Array<{requested_model:string;call_kind:string;status:string;error_type:string|null;latency_ms:number;prompt_tokens:number|null;completion_tokens:number|null;analytics_user_id:string|null;analytics_event_id:string|null;a_user_id:string|null;b_user_id:string|null}>;
  const modelGroups=new Map<string,{model:string;jobKind:string;calls:number;successful:number;failed:number;timeouts:number;duration:number;inputTokens:number;outputTokens:number;people:Set<string>}>();
  for(const row of modelRows) {
    const key=JSON.stringify([row.requested_model,row.call_kind]);
    const group=modelGroups.get(key)??{model:row.requested_model,jobKind:row.call_kind,calls:0,successful:0,failed:0,timeouts:0,duration:0,inputTokens:0,outputTokens:0,people:new Set<string>()};
    group.calls+=1; group.successful+=row.status==="success"?1:0; group.failed+=row.status!=="success"?1:0; group.timeouts+=["timeout","request_timeout","response_body_timeout"].includes(row.error_type??"")?1:0;
    group.duration+=row.latency_ms; group.inputTokens+=row.prompt_tokens??0; group.outputTokens+=row.completion_tokens??0;
    if(row.analytics_user_id)group.people.add(row.analytics_user_id);
    if(row.analytics_event_id) { if(row.a_user_id)group.people.add(row.a_user_id); if(row.b_user_id)group.people.add(row.b_user_id); }
    modelGroups.set(key,group);
  }
  const models=[...modelGroups.values()].filter(group=>group.people.size>=5).map(({people,duration,...group})=>({...group,averageDurationMs:Math.round(duration/group.calls)}));
  const detailsSuppressed=overview.users<5||allowed.length<funnel.length;
  return {days,generatedAt:now(),retentionDays:90,privacyThreshold:5,overview:{activeUsers:overview.users>=5?overview.users:0,sessions:overview.users>=5?overview.sessions:0,events:overview.users>=5?overview.events:0},funnel:allowed,conversationFunnel:allowed.filter(x=>x.name.startsWith("conversation_")),lastSteps,feedbackReasons,outcomes,detailsSuppressed,models};
}
