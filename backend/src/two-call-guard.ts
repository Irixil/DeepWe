import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "./db.js";

export interface TwoCallGuardConfig {
  parentHistory?: "closed_n1_20261010";
  scopeId: string;
  ownerUserId: string;
  conversationId: string;
  nextMessageSha256: string;
  inputVersion: number;
  sourceMessageVersion: 1;
  provider: "deepseek" | "aihubmix";
  model: "deepseek-v4-flash";
  expectedEndpoint: string;
  maxTokens: 8192;
  replyMaxRequestBytes: 16384;
  auditMaxRequestBytes: 32768;
  aiRuntimeSha256: string;
  sourceSetSha256: string;
  deadlineUtc: string;
}
export type TwoCallPhase = "reply" | "audit";
export type TwoCallJobContext = { jobId: string };
type GuardRow = { config_json: string; state: "armed" | "active" | "completed" | "stopped";
  job_id: string | null; source_message_id: string | null; parent_post_count: number;
  parent_get_count: number; known_nano: number; unknown_nano_1: number; unknown_nano_2: number;
  reserved_nano: number; error_code: string | null; parent_fingerprint:string };
type JobRow = { id: string; owner_user_id: string; conversation_id: string; kind: string;
  input_version: number; source_message_id: string | null; source_message_version: number | null; status: string };
type PhaseRow = { phase: TwoCallPhase; amount_nano: number; status: "reserved" | "succeeded" };

// This singleton is deliberately independent of conversation/job deletion and
// analytics retention. A new scope or UUID cannot mint a fresh parent allowance.
db.exec(`CREATE TABLE IF NOT EXISTS two_call_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_json TEXT NOT NULL,
  state TEXT NOT NULL, job_id TEXT, source_message_id TEXT,
  parent_post_count INTEGER NOT NULL, parent_get_count INTEGER NOT NULL,
  known_nano INTEGER NOT NULL, unknown_nano_1 INTEGER NOT NULL, unknown_nano_2 INTEGER NOT NULL,
  reserved_nano INTEGER NOT NULL DEFAULT 0, error_code TEXT, parent_fingerprint TEXT NOT NULL
); CREATE TABLE IF NOT EXISTS two_call_guard_phases (
  phase TEXT PRIMARY KEY CHECK(phase IN ('reply','audit')), job_id TEXT NOT NULL,
  amount_nano INTEGER NOT NULL, status TEXT NOT NULL, reserved_at INTEGER NOT NULL
);`);

// Shadow mirror of this frozen, approved P2 parent's history only. It does not
// replace the external parent authority/once/window or survive swapping the DB
// for an arbitrary older copy. Reservations are policy holds, not billed usage.
export const FROZEN_PARENT_FINGERPRINT = crypto.createHash("sha256").update("DeepWe:P2:20261010:POST11:GET1:known59610375:unknown16341375:unknown52278600").digest("hex");

export const CLOSED_N1_PARENT = Object.freeze({posts:14,gets:1,known:72051375,unknown1:16341375,unknown2:52278600,
  fingerprint:crypto.createHash("sha256").update("DeepWe:R1:20261010:POST14:GET1:known72051375:unknown16341375:unknown52278600").digest("hex")});
function parentFor(config: TwoCallGuardConfig) {
  return config.parentHistory === "closed_n1_20261010" ? CLOSED_N1_PARENT
    : {posts:11,gets:1,known:59610375,unknown1:16341375,unknown2:52278600,fingerprint:FROZEN_PARENT_FINGERPRINT};
}

export class TwoCallGuardError extends Error {
  constructor() { super("This model batch is stopped or outside its persisted authorization"); this.name="TwoCallGuardError"; }
}
function row(): GuardRow | undefined {
  return db.prepare("SELECT * FROM two_call_guard WHERE singleton=1").get() as GuardRow | undefined;
}
function stop(code: string): void {
  db.prepare("UPDATE two_call_guard SET state='stopped',error_code=? WHERE singleton=1").run(code);
}
export function twoCallGuardConfigured(): boolean { return Boolean(row()); }
export function getTwoCallAiRuntimeSha256(): string {
  const extension=import.meta.url.endsWith(".ts")?"ts":"js";
  return crypto.createHash("sha256").update(fs.readFileSync(new URL(`./ai.${extension}`,import.meta.url))).digest("hex");
}
export function getTwoCallGuardState() {
  const guard=row();
  return guard ? { ...guard, config: JSON.parse(guard.config_json) as Partial<TwoCallGuardConfig>,
    phases: db.prepare("SELECT * FROM two_call_guard_phases ORDER BY reserved_at,phase").all() as PhaseRow[],
    worstCaseNano: guard.known_nano+guard.unknown_nano_1+guard.unknown_nano_2+guard.reserved_nano } : null;
}

/** Trusted server initialization only; never exposed as a client route. */
export function initializeTwoCallGuard(config: TwoCallGuardConfig): void {
  db.pragma("synchronous = FULL");
  let serialized="{}";
  let serializable=true;
  try { serialized=JSON.stringify(config) ?? "{}"; } catch { serializable=false; }
  config=config && typeof config==="object" ? config : {} as TwoCallGuardConfig;
  const ok=db.transaction(()=>{
    const old=row();
    if(old) {
      if(old.config_json!==serialized) stop("CONFIG_CHANGED");
      return old.config_json===serialized && old.state!=="stopped";
    }
    const parent=parentFor(config);
    let valid=false;
    try {
    const conv=typeof config.conversationId==="string" ? db.prepare("SELECT owner_user_id,version,status FROM private_conversations WHERE id=?").get(config.conversationId) as {owner_user_id:string;version:number;status:string}|undefined : undefined;
    let validEndpoint=false;
    try {
      const endpoint=new URL(config.expectedEndpoint);
      validEndpoint=!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash
        && endpoint.pathname.endsWith("/chat/completions")
        && (endpoint.protocol==="https:" || (endpoint.protocol==="http:" && ["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname)));
    } catch { /* Invalid configuration must leave a durable stopped latch. */ }
    valid=Boolean((config.parentHistory===undefined || config.parentHistory==="closed_n1_20261010") && serializable && typeof config.scopeId==="string" && config.scopeId.trim() && config.scopeId.length<=200
      && conv?.owner_user_id===config.ownerUserId && conv.status==="active"
      && Number.isSafeInteger(config.inputVersion) && config.inputVersion===conv.version+1
      && /^[a-f0-9]{64}$/.test(config.nextMessageSha256)
      && config.sourceMessageVersion===1 && ["deepseek","aihubmix"].includes(config.provider)
      && config.model==="deepseek-v4-flash" && config.maxTokens===8192
      && config.replyMaxRequestBytes===16384 && config.auditMaxRequestBytes===32768 && validEndpoint
      && config.aiRuntimeSha256===getTwoCallAiRuntimeSha256() && /^[a-f0-9]{64}$/.test(config.sourceSetSha256)
      && Number.isFinite(Date.parse(config.deadlineUtc)) && Date.parse(config.deadlineUtc)>Date.now());
    } catch { valid=false; }
    db.prepare(`INSERT INTO two_call_guard(singleton,config_json,state,parent_post_count,parent_get_count,
      known_nano,unknown_nano_1,unknown_nano_2,error_code,parent_fingerprint) VALUES(1,?,?,?,?,?,?,?,?,?)`)
      .run(serialized,valid?"armed":"stopped",parent.posts,parent.gets,parent.known,parent.unknown1,parent.unknown2,valid?null:"INVALID_CONFIG",parent.fingerprint);
    return valid;
  }).immediate();
  if(!ok) throw new TwoCallGuardError();
}

function matches(job: JobRow, guard: GuardRow): boolean {
  const c=JSON.parse(guard.config_json) as TwoCallGuardConfig;
  const source=job.source_message_id ? db.prepare("SELECT content,version,status,role FROM private_messages WHERE id=? AND conversation_id=?").get(job.source_message_id,job.conversation_id) as {content:string;version:number;status:string;role:string}|undefined : undefined;
  const conv=db.prepare("SELECT owner_user_id,version,status FROM private_conversations WHERE id=?").get(job.conversation_id) as {owner_user_id:string;version:number;status:string}|undefined;
  return job.kind==="reply" && job.owner_user_id===c.ownerUserId && job.conversation_id===c.conversationId
    && job.input_version===c.inputVersion && job.source_message_version===c.sourceMessageVersion
    && source?.role==="user" && source.status==="current" && source.version===c.sourceMessageVersion
    && crypto.createHash("sha256").update(source.content,"utf8").digest("hex")===c.nextMessageSha256
    && conv?.owner_user_id===c.ownerUserId && conv.status==="active" && conv.version===c.inputVersion;
}

// Called inside the ordinary newJob transaction, after its real UUID exists.
export function bindTwoCallPrivateJob(jobId: string): void {
  const guard=row(); if(!guard || guard.state!=="armed" || guard.job_id) return;
  const job=db.prepare("SELECT * FROM private_jobs WHERE id=?").get(jobId) as JobRow|undefined;
  const c=JSON.parse(guard.config_json) as TwoCallGuardConfig;
  if(!job || job.kind!=="reply" || job.owner_user_id!==c.ownerUserId || job.conversation_id!==c.conversationId) return;
  if(!matches(job,guard)) { stop("SOURCE_MISMATCH"); return; }
  db.prepare("UPDATE two_call_guard SET job_id=?,source_message_id=? WHERE singleton=1 AND job_id IS NULL")
    .run(job.id,job.source_message_id);
}
export function twoCallPrivateJobEligible(job: JobRow): boolean {
  const guard=row(); if(!guard) return true;
  return guard.state==="armed" && guard.job_id===job.id && matches(job,guard)
    && !db.prepare("SELECT 1 FROM two_call_guard_phases LIMIT 1").get();
}
export function stopTwoCallJob(jobId: string, code="JOB_FAILED"): void {
  if(row()?.job_id===jobId) stop(code);
}

export function assertTwoCallStage(callKind: string, context?: TwoCallJobContext, phase?: TwoCallPhase): void {
  const guard=row(); if(!guard) return;
  const c=JSON.parse(guard.config_json) as TwoCallGuardConfig;
  const job=context?db.prepare("SELECT * FROM private_jobs WHERE id=?").get(context.jobId) as JobRow|undefined:undefined;
  if(!["armed","active"].includes(guard.state) || callKind!=="private_reply" || !context
    || guard.job_id!==context.jobId || !phase || !job || job.status!=="processing" || !matches(job,guard)
    || Date.parse(c.deadlineUtc)<=Date.now() || c.aiRuntimeSha256!==getTwoCallAiRuntimeSha256()) throw new TwoCallGuardError();
}
/** Atomic permanent shadow-budget reservation; never refund, even on failure. */
export function reserveTwoCallTransport(input: {callKind:string;context?:TwoCallJobContext;phase?:TwoCallPhase;
  provider:string;model:string;endpoint:string;maxTokens:number;requestBytes:number;
  thinking:boolean;reasoningEffort:string;timeoutMs:number}): boolean {
  if(!row()) return false;
  db.pragma("synchronous = FULL");
  const ok=db.transaction(()=>{
    const guard=row()!;
    const c=JSON.parse(guard.config_json) as TwoCallGuardConfig;
    const job=input.context ? db.prepare("SELECT * FROM private_jobs WHERE id=?").get(input.context.jobId) as JobRow|undefined : undefined;
    const parent=parentFor(c);
    const phase=input.phase;
    const amount=phase==="reply"?19200000:25344000;
    const previous=db.prepare("SELECT * FROM two_call_guard_phases WHERE phase='reply'").get() as PhaseRow|undefined;
    const valid=["armed","active"].includes(guard.state) && input.callKind==="private_reply"
      && job?.id===guard.job_id && job.status==="processing" && matches(job,guard)
      && (phase==="reply" || (phase==="audit" && previous?.status==="succeeded"))
      && !db.prepare("SELECT 1 FROM two_call_guard_phases WHERE phase=?").get(phase??"")
      && input.provider===c.provider && input.model===c.model && input.endpoint===c.expectedEndpoint
      && input.maxTokens===8192 && input.thinking && input.reasoningEffort==="high"
      && c.aiRuntimeSha256===getTwoCallAiRuntimeSha256() && Date.parse(c.deadlineUtc)>Date.now()
      && input.timeoutMs>0 && input.timeoutMs<=35000
      && input.requestBytes>0 && input.requestBytes<=(phase==="reply"?16384:32768)
      && guard.parent_fingerprint===parent.fingerprint
      && guard.known_nano===parent.known && guard.unknown_nano_1===parent.unknown1 && guard.unknown_nano_2===parent.unknown2
      && guard.parent_post_count+1<=parent.posts+2 && guard.parent_get_count===parent.gets
      && guard.known_nano+guard.unknown_nano_1+guard.unknown_nano_2+guard.reserved_nano+amount<=600000000;
    if(!valid) { stop("TRANSPORT_DENIED"); return false; }
    db.prepare("INSERT INTO two_call_guard_phases(phase,job_id,amount_nano,status,reserved_at) VALUES(?,?,?,'reserved',?)")
      .run(phase!,job!.id,amount,Date.now());
    db.prepare("UPDATE two_call_guard SET state='active',parent_post_count=parent_post_count+1,reserved_nano=reserved_nano+? WHERE singleton=1").run(amount);
    return true;
  }).immediate();
  if(!ok) throw new TwoCallGuardError();
  return true;
}
export function succeedTwoCallPhase(context?:TwoCallJobContext,phase?:TwoCallPhase): void {
  const guard=row(); if(!guard) return;
  if(guard.state!=="active" || guard.job_id!==context?.jobId || !phase) throw new TwoCallGuardError();
  if(!db.prepare("UPDATE two_call_guard_phases SET status='succeeded' WHERE phase=? AND job_id=? AND status='reserved'").run(phase,context.jobId).changes) throw new TwoCallGuardError();
}
export function completeTwoCallJob(jobId:string): void {
  const guard=row(); if(!guard) return;
  if(guard.state!=="active" || guard.job_id!==jobId
    || (db.prepare("SELECT COUNT(*) count FROM two_call_guard_phases WHERE job_id=? AND status='succeeded'").get(jobId) as {count:number}).count!==2) throw new TwoCallGuardError();
  db.prepare("UPDATE two_call_guard SET state='completed' WHERE singleton=1").run();
}
