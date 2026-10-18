import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "./db.js";
import { getTwoCallGuardState } from "./two-call-guard.js";
import { databasePersistenceConfigured } from "./persistence.js";

export interface NotesDispatchGuardConfig {
  scopeId: string;
  jobId: string;
  ownerUserId: string;
  conversationId: string;
  inputVersion: number;
  jobPayloadSha256: string;
  sources: Array<{ id: string; version: number; contentSha256: string; originalCreatedAtUtc: string }>;
  completedReplyJobId: string;
  assistant: { id: string; version: number; contentSha256: string };
  provider: "deepseek" | "aihubmix";
  model: "deepseek-v4-flash";
  expectedEndpoint: string;
  maxTokens: 8192;
  maxRequestBytes: 8192;
  requestBodySha256: string;
  requestBodyBytes: number;
  timeoutMs: 60000;
  aiRuntimeSha256: string;
  sourceSetSha256: string;
  deadlineUtc: string;
}
type JobRow = { id: string; owner_user_id: string; conversation_id: string; kind: string; input_version: number; payload: string; status: string };
type GuardRow = { config_json: string; state: "armed" | "reserved" | "transport_succeeded" | "completed" | "stopped";
  parent_post_count: number; parent_get_count: number; known_nano: number; unknown_nano_1: number; unknown_nano_2: number;
  reserved_nano: number; error_code: string | null; old_p2_sha256: string; parent_fingerprint: string; reserved_at: number | null; product_ack_at: number | null };
const sha = (value: string) => crypto.createHash("sha256").update(value,"utf8").digest("hex");
const isSha = (value: unknown): value is string => typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
export const NOTES_PARENT_FINGERPRINT = sha("DeepWe:N1:20261010:POST13:GET1:known67026750:unknown16341375:unknown52278600");
export const NOTES_RESERVE_NANO = 16128000;

// Independent of private job/conversation deletion and of the closed P2 singleton.
// This is a frozen parent's local mirror, not protection against replacing the
// database with an arbitrary older snapshot or bypassing the external authority.
db.exec(`CREATE TABLE IF NOT EXISTS notes_dispatch_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_json TEXT NOT NULL, state TEXT NOT NULL,
  parent_post_count INTEGER NOT NULL, parent_get_count INTEGER NOT NULL, known_nano INTEGER NOT NULL,
  unknown_nano_1 INTEGER NOT NULL, unknown_nano_2 INTEGER NOT NULL, reserved_nano INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, old_p2_sha256 TEXT NOT NULL, parent_fingerprint TEXT NOT NULL,
  reserved_at INTEGER, product_ack_at INTEGER
);`);
export class NotesDispatchGuardError extends Error {
  constructor() { super("This notes batch is stopped or outside its persisted authorization"); this.name="NotesDispatchGuardError"; }
}
function row(): GuardRow | undefined { return db.prepare("SELECT * FROM notes_dispatch_guard WHERE singleton=1").get() as GuardRow | undefined; }
function stop(code: string): void { db.prepare("UPDATE notes_dispatch_guard SET state='stopped',error_code=? WHERE singleton=1").run(code); }
function oldP2Fingerprint(): string { return sha(JSON.stringify(getTwoCallGuardState())); }
export function notesDispatchGuardConfigured(): boolean { return Boolean(row()); }
export function getNotesAiRuntimeSha256(): string {
  const extension=import.meta.url.endsWith(".ts")?"ts":"js";
  return sha(fs.readFileSync(new URL(`./ai.${extension}`,import.meta.url),"utf8"));
}
export function getNotesDispatchGuardState() {
  const guard=row();
  return guard ? {...guard,config:JSON.parse(guard.config_json) as NotesDispatchGuardConfig,
    worstCaseNano:guard.known_nano+guard.unknown_nano_1+guard.unknown_nano_2+guard.reserved_nano} : null;
}
function persistenceReady(): boolean {
  return databasePersistenceConfigured() && process.env.DEEPWE_PERSISTENCE_REQUIRED==="true";
}
function sourceBindingsMatch(c: NotesDispatchGuardConfig): boolean {
  const conv=db.prepare("SELECT owner_user_id,status,version FROM private_conversations WHERE id=?").get(c.conversationId) as {owner_user_id:string;status:string;version:number}|undefined;
  const sources=db.prepare("SELECT id,version,content,created_at FROM private_messages WHERE conversation_id=? AND role='user' AND status='current' ORDER BY created_at,rowid").all(c.conversationId) as Array<{id:string;version:number;content:string;created_at:number}>;
  const assistant=db.prepare("SELECT version,content,status,role FROM private_messages WHERE id=? AND conversation_id=?").get(c.assistant.id,c.conversationId) as {version:number;content:string;status:string;role:string}|undefined;
  const reply=db.prepare("SELECT status,result_message_id,owner_user_id,conversation_id,kind FROM private_jobs WHERE id=?").get(c.completedReplyJobId) as {status:string;result_message_id:string;owner_user_id:string;conversation_id:string;kind:string}|undefined;
  return conv?.owner_user_id===c.ownerUserId && conv.status==="active" && conv.version===c.inputVersion
    && sources.length===c.sources.length && sources.every((source,index)=>{
      const expected=c.sources[index];
      return source.id===expected.id && source.version===expected.version && sha(source.content)===expected.contentSha256
        && new Date(source.created_at).toISOString()===expected.originalCreatedAtUtc;
    }) && assistant?.role==="assistant" && assistant.status==="current" && assistant.version===c.assistant.version && sha(assistant.content)===c.assistant.contentSha256
    && reply?.kind==="reply" && reply.status==="completed" && reply.owner_user_id===c.ownerUserId && reply.conversation_id===c.conversationId && reply.result_message_id===c.assistant.id;
}
function matches(job: JobRow, guard: GuardRow): boolean {
  try {
    const c=JSON.parse(guard.config_json) as NotesDispatchGuardConfig;
    return job.id===c.jobId && job.kind==="notes" && job.owner_user_id===c.ownerUserId && job.conversation_id===c.conversationId
      && job.input_version===c.inputVersion && sha(job.payload)===c.jobPayloadSha256 && sourceBindingsMatch(c)
      && oldP2Fingerprint()===guard.old_p2_sha256;
  } catch { return false; }
}

/** Trusted initialization only. Same database keeps one irreversible N1 scope. */
export function initializeNotesDispatchGuard(config: NotesDispatchGuardConfig): void {
  db.pragma("synchronous = FULL");
  let serialized="{}", serializable=true;
  try { serialized=JSON.stringify(config) ?? "{}"; } catch { serializable=false; }
  const ok=db.transaction(()=>{
    const previous=row();
    if(previous) {
      if(previous.config_json!==serialized) { stop("CONFIG_CHANGED"); return false; }
      if(previous.state==="reserved" || previous.state==="transport_succeeded") { stop("INTERRUPTED_RESERVED_REQUEST"); return false; }
      return previous.state!=="stopped";
    }
    let valid=false;
    try {
      const old=getTwoCallGuardState();
      const c=config;
      const job=db.prepare("SELECT * FROM private_jobs WHERE id=?").get(c.jobId) as JobRow|undefined;
      const endpoint=new URL(c.expectedEndpoint);
      const endpointValid=!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash
        && endpoint.pathname.endsWith("/chat/completions") && (endpoint.protocol==="https:" || (endpoint.protocol==="http:" && ["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname)));
      valid=Boolean(serializable && persistenceReady() && typeof c.scopeId==="string" && c.scopeId.trim() && c.scopeId.length<=200
        && old?.state==="completed" && old.job_id===c.completedReplyJobId && old.config.ownerUserId===c.ownerUserId && old.config.conversationId===c.conversationId
        && job?.status==="queued" && job.kind==="notes" && job.owner_user_id===c.ownerUserId && job.conversation_id===c.conversationId
        && Number.isSafeInteger(c.inputVersion) && job.input_version===c.inputVersion && isSha(c.jobPayloadSha256) && sha(job.payload)===c.jobPayloadSha256
        && Array.isArray(c.sources) && c.sources.length===2 && new Set(c.sources.map(source=>source.id)).size===2
        && c.sources.every(source=>typeof source.id==="string" && source.version===1 && isSha(source.contentSha256) && Number.isFinite(Date.parse(source.originalCreatedAtUtc)))
        && c.assistant?.version===1 && isSha(c.assistant.contentSha256) && sourceBindingsMatch(c)
        && ["deepseek","aihubmix"].includes(c.provider) && c.model==="deepseek-v4-flash" && endpointValid
        && c.maxTokens===8192 && c.maxRequestBytes===8192 && c.timeoutMs===60000
        && isSha(c.requestBodySha256) && Number.isSafeInteger(c.requestBodyBytes) && c.requestBodyBytes>0 && c.requestBodyBytes<=8192
        && c.aiRuntimeSha256===getNotesAiRuntimeSha256() && isSha(c.sourceSetSha256)
        && Number.isFinite(Date.parse(c.deadlineUtc)) && Date.parse(c.deadlineUtc)>Date.now());
    } catch { valid=false; }
    db.prepare(`INSERT INTO notes_dispatch_guard(singleton,config_json,state,parent_post_count,parent_get_count,known_nano,unknown_nano_1,unknown_nano_2,error_code,old_p2_sha256,parent_fingerprint)
      VALUES(1,?,?,13,1,67026750,16341375,52278600,?,?,?)`).run(serialized,valid?"armed":"stopped",valid?null:"INVALID_CONFIG",oldP2Fingerprint(),NOTES_PARENT_FINGERPRINT);
    return valid;
  }).immediate();
  if(!ok) throw new NotesDispatchGuardError();
}
export function notesPrivateJobEligible(job: JobRow): boolean {
  const guard=row(); if(!guard) return true;
  return guard.state==="armed" && guard.reserved_nano===0 && matches(job,guard)
    && Date.parse((JSON.parse(guard.config_json) as NotesDispatchGuardConfig).deadlineUtc)>Date.now();
}
export function assertNotesDispatchStage(callKind: string, context?: {jobId:string}): void {
  const guard=row(); if(!guard) return;
  const c=JSON.parse(guard.config_json) as NotesDispatchGuardConfig;
  const job=context?db.prepare("SELECT * FROM private_jobs WHERE id=?").get(context.jobId) as JobRow|undefined:undefined;
  if(!["armed","reserved"].includes(guard.state) || callKind!=="private_notes" || !job || job.status!=="processing" || !matches(job,guard)
    || !persistenceReady() || Date.parse(c.deadlineUtc)<=Date.now() || c.aiRuntimeSha256!==getNotesAiRuntimeSha256()) {
    stop("STAGE_DENIED"); throw new NotesDispatchGuardError();
  }
}
/** Permanent full policy hold. Snapshot acknowledgment is required before fetch. */
export function reserveNotesDispatchTransport(input: {callKind:string;context?:{jobId:string};provider:string;model:string;endpoint:string;maxTokens:number;
  body:string;thinking:boolean;reasoningEffort:string;timeoutMs:number}): boolean {
  if(!row()) return false;
  db.pragma("synchronous = FULL");
  const ok=db.transaction(()=>{
    const guard=row()!; const c=JSON.parse(guard.config_json) as NotesDispatchGuardConfig;
    const job=input.context?db.prepare("SELECT * FROM private_jobs WHERE id=?").get(input.context.jobId) as JobRow|undefined:undefined;
    const bytes=Buffer.byteLength(input.body,"utf8");
    const valid=guard.state==="armed" && guard.reserved_nano===0 && input.callKind==="private_notes" && job?.status==="processing" && matches(job,guard)
      && persistenceReady() && Date.parse(c.deadlineUtc)>Date.now() && c.aiRuntimeSha256===getNotesAiRuntimeSha256()
      && input.provider===c.provider && input.model===c.model && input.endpoint===c.expectedEndpoint && input.maxTokens===8192
      && input.thinking && input.reasoningEffort==="high" && input.timeoutMs===60000
      && bytes===c.requestBodyBytes && bytes<=8192 && sha(input.body)===c.requestBodySha256
      && guard.parent_fingerprint===NOTES_PARENT_FINGERPRINT && guard.parent_post_count===13 && guard.parent_get_count===1
      && guard.known_nano===67026750 && guard.unknown_nano_1===16341375 && guard.unknown_nano_2===52278600
      && guard.parent_post_count+1<=24 && guard.known_nano+guard.unknown_nano_1+guard.unknown_nano_2+NOTES_RESERVE_NANO<=600000000;
    if(!valid) { stop("TRANSPORT_DENIED"); return false; }
    db.prepare("UPDATE notes_dispatch_guard SET state='reserved',reserved_nano=?,parent_post_count=parent_post_count+1,reserved_at=? WHERE singleton=1").run(NOTES_RESERVE_NANO,Date.now());
    return true;
  }).immediate();
  if(!ok) throw new NotesDispatchGuardError();
  return true;
}
export function markNotesTransportSucceeded(context?: {jobId:string}): void {
  const guard=row(); if(!guard) return;
  const c=JSON.parse(guard.config_json) as NotesDispatchGuardConfig;
  if(guard.state!=="reserved" || c.jobId!==context?.jobId) { stop("TRANSPORT_ACK_DENIED"); throw new NotesDispatchGuardError(); }
  db.prepare("UPDATE notes_dispatch_guard SET state='transport_succeeded' WHERE singleton=1").run();
}
export function completeNotesDispatchJob(jobId: string): void {
  const guard=row(); if(!guard) return;
  const c=JSON.parse(guard.config_json) as NotesDispatchGuardConfig;
  const job=db.prepare("SELECT * FROM private_jobs WHERE id=?").get(jobId) as JobRow|undefined;
  if(guard.state!=="transport_succeeded" || !job || job.status!=="completed" || !matches(job,guard)) { stop("PRODUCT_ACK_DENIED"); throw new NotesDispatchGuardError(); }
  db.prepare("UPDATE notes_dispatch_guard SET state='completed',product_ack_at=? WHERE singleton=1").run(Date.now());
}
export function stopNotesDispatchJob(jobId: string, code="JOB_FAILED"): void {
  const guard=row(); if(guard && (JSON.parse(guard.config_json) as NotesDispatchGuardConfig).jobId===jobId) stop(code);
}
export function recoverInterruptedNotesDispatch(): void {
  const guard=row(); if(!guard || !["reserved","transport_succeeded"].includes(guard.state)) return;
  const c=JSON.parse(guard.config_json) as NotesDispatchGuardConfig;
  stop("INTERRUPTED_RESERVED_REQUEST");
  db.prepare("UPDATE private_jobs SET status='failed',error_code='BATCH_STOPPED',updated_at=? WHERE id=? AND status IN ('queued','processing')").run(Date.now(),c.jobId);
}
