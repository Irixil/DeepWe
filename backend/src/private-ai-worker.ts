import { notesDispatchGuardConfigured, stopNotesDispatchJob } from "./notes-dispatch-guard.js";
import { db, describePersonalPreferences } from "./db.js";
import { createPrivateShareDraft, privateConversationReply, refreshPrivateConversationNotes, AiServiceError } from "./ai.js";
import * as core from "./private-core.js";
import { getPrivateMemoryReplySnapshot } from "./private-memory.js";
import { persistDatabaseIfChanged } from "./persistence.js";

const state = globalThis as unknown as { __deepwePrivateForegroundRunning?: boolean; __deepwePrivateBackgroundRunning?: boolean };

function analyticsUserId(userId: string): string | undefined {
  const row = db.prepare(`SELECT analytics_enabled FROM users WHERE id=?`).get(userId) as {analytics_enabled:number}|undefined;
  return row?.analytics_enabled ? userId : undefined;
}

function serverTimeUtc(createdAt: number): string {
  return new Date(createdAt).toISOString();
}

function notesWithSourceTimes(notes: core.PrivateNote[], messages: core.PrivateMessage[]) {
  const byId = new Map(messages.map(message => [message.id, message]));
  return notes.map(({ updatedAt: _updatedAt, ...note }) => {
    // A correction replaces the generated interpretation for model context.
    // Keep provenance and status, but never present the invalidated text beside it.
    const effective=note.status==="corrected"&&note.correction?.trim()
      ? (({correction:_correction,...rest})=>({...rest,kind:"user_statement" as const,content:note.correction!}))(note)
      : note;
    return {
      ...effective,
      sourceMessageTimes: effective.sourceMessageIds.flatMap(id => {
        const source = byId.get(id);
        return source ? [{ id, version: source.version, originalCreatedAtUtc: serverTimeUtc(source.createdAt) }] : [];
      }),
    };
  });
}

async function processJob(job: NonNullable<ReturnType<typeof core.claimPrivateJob>>) {
  try {
    if(job.kind==="reply") {
      const messages=core.listCurrentMessages(job.conversationId);
      const source=messages.find(item=>item.id===job.sourceMessageId && item.role==="user");
      if(!source || source.version!==job.sourceMessageVersion) { core.cancelPrivateJobWork(job.id); return; }
      const context=core.getReplyContext(job.conversationId);
      const riskMessages=core.getActiveRiskMessages(job.ownerUserId,job.conversationId);
      const history=[...new Map([...riskMessages,...context.history]
        .filter(item=>item.id!==source.id)
        .map(item=>[item.id,item])).values()].sort((a,b)=>a.createdAt-b.createdAt);
      const memorySnapshot=getPrivateMemoryReplySnapshot(job.ownerUserId, source.content, job.conversationId, source.id,
        history.filter(item=>item.role==="user").slice(-2).map(item=>item.content));
      const result=await privateConversationReply({
        history:history.map(({id,role,content,version,createdAt})=>({id,role,content,version,...(role==="user"?{originalCreatedAtUtc:serverTimeUtc(createdAt)}:{})})),
        message:source.content,
        jobContext:{jobId:job.id},
        messageSource:{id:source.id,version:source.version,originalCreatedAtUtc:serverTimeUtc(source.createdAt)},
        notes:notesWithSourceTimes(context.notes,messages),
        privateMemory:memorySnapshot.items,
        pendingMemoryCorrections:memorySnapshot.pendingCorrections,
        knownMemoryCorrections:memorySnapshot.knownCorrections,
        personalPreferences:[...describePersonalPreferences(job.ownerUserId),...core.listResponsePreferences(job.ownerUserId,job.conversationId).map(item=>`本段潜谈偏好：${item}`)],
        analyticsUserId:analyticsUserId(job.ownerUserId),
        analyticsConversationId:job.conversationId,
        riskAlreadyAddressed:core.hasSafetyReplyAfterActiveRisk(job.ownerUserId,job.conversationId),
      });
      if(!core.completePrivateJob(job.id,result,result.safetyResponse ? undefined : memorySnapshot)) core.failPrivateJob(job.id,"RESULT_NOT_COMMITTED");
      return;
    }
    if(job.kind==="notes") {
      const currentMessages=core.listCurrentMessages(job.conversationId).filter(item=>item.role==="user");
      const messages=currentMessages.map(({id,content,version,createdAt})=>({id,content,version,originalCreatedAtUtc:serverTimeUtc(createdAt)}));
      const currentNotes=core.listCurrentNotes(job.conversationId);
      // Full, current user messages are the evidence for a refresh. Only carry
      // explicit owner corrections forward; uncorrected model notes are not facts.
      const priorNotes=notesWithSourceTimes(currentNotes.filter(item=>item.status==="corrected"),core.listCurrentMessages(job.conversationId));
      const notes=await refreshPrivateConversationNotes({
        jobContext:{jobId:job.id},
        priorNotes,
        messages,
        corrections:currentNotes.filter(item=>item.correction).map(item=>({id:item.id,correction:item.correction!})),
        analyticsUserId:analyticsUserId(job.ownerUserId),
        analyticsConversationId:job.conversationId,
      });
      if(!core.completePrivateJob(job.id,notes)) stopNotesDispatchJob(job.id,"RESULT_NOT_COMMITTED");
      if(notesDispatchGuardConfigured()) {
        try { await persistDatabaseIfChanged(true); }
        catch(error) { stopNotesDispatchJob(job.id,"PRODUCT_SNAPSHOT_FAILED"); throw error; }
      }
      return;
    }
    const payload=job.payload as {draftId:string;sourceMessageIds:string[]};
    const messages=core.getShareDraftSources(job.conversationId,payload.sourceMessageIds);
    if(messages.length!==new Set(payload.sourceMessageIds).size) { core.failPrivateJob(job.id,"SOURCE_EXPIRED"); return; }
    const result=await createPrivateShareDraft({messages,jobContext:{jobId:job.id},analyticsUserId:analyticsUserId(job.ownerUserId),analyticsConversationId:job.conversationId});
    core.completePrivateJob(job.id,result);
  } catch(error) {
    // Deliberately exclude prompts, messages and provider response bodies from logs.
    console.error("Private AI job failed",{jobId:job.id,kind:job.kind,reason:error instanceof AiServiceError?"provider_unavailable":"processing_error"});
    core.failPrivateJob(job.id,error instanceof AiServiceError?"AI_UNAVAILABLE":"PROCESSING_FAILED");
  } finally {
    try { await persistDatabaseIfChanged(); }
    catch { console.error("Private AI result snapshot failed; retrying automatically"); }
  }
}

function wakeLane(lane:core.PrivateJobLane):void {
  const runningKey=lane==="foreground"?"__deepwePrivateForegroundRunning":"__deepwePrivateBackgroundRunning";
  if(state[runningKey])return;
  state[runningKey]=true;
  queueMicrotask(async()=>{
    try {
      let job=core.claimPrivateJob(lane);
      while(job){await processJob(job);job=core.claimPrivateJob(lane);}
    } finally {
      state[runningKey]=false;
      if(core.privateJobsQueued("foreground"))wakeLane("foreground");
      if(core.privateJobsQueued("background"))wakeLane("background");
    }
  });
}

export function wakePrivateWorker():void {
  wakeLane("foreground");
  wakeLane("background");
}

export function startPrivateWorker():void { core.requeueInterruptedPrivateJobs(); wakePrivateWorker(); }
