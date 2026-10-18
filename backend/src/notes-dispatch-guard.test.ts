import type { NotesDispatchGuardConfig } from "./notes-dispatch-guard";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// New synthetic disk database only; no dotenv or real database is loaded.
const fixtureDir=fs.mkdtempSync(path.join(os.tmpdir(),"deepwe-notes-once-"));
process.env.DATA_DIR=fixtureDir;
process.env.DEEPWE_DATABASE_PATH=path.join(fixtureDir,"local.sqlite");
process.env.DEEPWE_PERSISTENT_DIR=path.join(fixtureDir,"persistent");
process.env.DEEPWE_PERSISTENCE_REQUIRED="true";
const {db,createUser}=await import("./db");
const core=await import("./private-core");
const worker=await import("./private-ai-worker");
const ai=await import("./ai");
const persistence=await import("./persistence");
const guard=await import("./notes-dispatch-guard");
const oldGuard=await import("./two-call-guard");
const sha=(text:string)=>crypto.createHash("sha256").update(text,"utf8").digest("hex");

beforeEach(()=>{
  db.prepare("UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')").run();
  db.prepare("DELETE FROM notes_dispatch_guard").run();
  db.prepare("DELETE FROM two_call_guard_phases").run();db.prepare("DELETE FROM two_call_guard").run();
  vi.stubEnv("DEEPSEEK_API_KEY","synthetic-offline-key");vi.stubEnv("DEEPWE_PRIVATE_PROVIDER","deepseek");
  vi.stubEnv("DEEPWE_PRIVATE_MODEL","deepseek-v4-flash");
  vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("unexpected fixture transport");}));
  vi.spyOn(console,"error").mockImplementation(()=>undefined);
});
afterEach(async()=>{
  await vi.waitFor(()=>expect((globalThis as {__deepwePrivateBackgroundRunning?:boolean}).__deepwePrivateBackgroundRunning).not.toBe(true));
  vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();
});
afterAll(()=>{
  db.close();fs.rmSync(fixtureDir,{recursive:true,force:true});
  delete process.env.DATA_DIR;delete process.env.DEEPWE_DATABASE_PATH;
  delete process.env.DEEPWE_PERSISTENT_DIR;delete process.env.DEEPWE_PERSISTENCE_REQUIRED;
  delete (globalThis as {__deepweDb?:unknown}).__deepweDb;
});
function response(content:string) { return new Response(JSON.stringify({model:"deepseek-flash",choices:[{finish_reason:"stop",message:{content}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}),{status:200}); }
async function setup() {
  const user=createUser(`${crypto.randomUUID()}@notes-once.test`,"合成笔记单次用户","hash","salt",false);
  const conv=core.createConversation(user.id);
  const one=core.addUserMessage(user.id,conv.id,"我们约好散步，对方晚到二十分钟。我有些失落，原因还没有问清楚。")!;
  core.cancelJob(user.id,conv.id,one.jobId!);
  const two=core.addUserMessage(user.id,conv.id,"更正：散步晚到不是二十分钟，是十分钟。其他事实不变。")!;
  const reply=core.claimPrivateJob("foreground")!;
  expect(reply.id).toBe(two.jobId);
  expect(core.completePrivateJob(reply.id,{reply:"你已明确更正为十分钟，原因仍没有确认。"})).toBe(true);
  const notesJob=db.prepare("SELECT * FROM private_jobs WHERE conversation_id=? AND kind='notes' AND status='queued' ORDER BY rowid DESC LIMIT 1").get(conv.id) as {id:string;input_version:number;payload:string};
  const sources=core.listCurrentMessages(conv.id).filter(message=>message.role==="user");
  const content=JSON.stringify({notes:[{kind:"unknown",content:"晚到的原因尚未确认。",sourceMessageIds:[one.message.id]}]});
  let body="";
  vi.stubGlobal("fetch",vi.fn(async(_url:unknown,init?:RequestInit)=>{body=String(init?.body);return response(content);}));
  await ai.refreshPrivateConversationNotes({messages:sources.map(message=>({id:message.id,content:message.content,version:message.version,originalCreatedAtUtc:new Date(message.createdAt).toISOString()})),priorNotes:[],corrections:[]});
  // Closed P2 is a synthetic prior-history fixture; no old real scope is opened.
  const oldConfig={ownerUserId:user.id,conversationId:conv.id};
  db.prepare(`INSERT INTO two_call_guard(singleton,config_json,state,job_id,source_message_id,parent_post_count,parent_get_count,known_nano,unknown_nano_1,unknown_nano_2,reserved_nano,parent_fingerprint)
    VALUES(1,?,'completed',?,?,13,1,59610375,16341375,52278600,44544000,?)`).run(JSON.stringify(oldConfig),reply.id,two.message.id,oldGuard.FROZEN_PARENT_FINGERPRINT);
  for(const phase of ["reply","audit"]) db.prepare("INSERT INTO two_call_guard_phases VALUES(?,?,?,'succeeded',?)").run(phase,reply.id,phase==="reply"?19200000:25344000,Date.now());
  const assistant=core.listCurrentMessages(conv.id).find(message=>message.role==="assistant")!;
  const config:NotesDispatchGuardConfig={scopeId:crypto.randomUUID(),jobId:notesJob.id,ownerUserId:user.id,conversationId:conv.id,inputVersion:notesJob.input_version,
    jobPayloadSha256:sha(notesJob.payload),sources:sources.map(source=>({id:source.id,version:source.version,contentSha256:sha(source.content),originalCreatedAtUtc:new Date(source.createdAt).toISOString()})),
    completedReplyJobId:reply.id,assistant:{id:assistant.id,version:assistant.version,contentSha256:sha(assistant.content)},provider:"deepseek",model:"deepseek-v4-flash",
    expectedEndpoint:"https://api.deepseek.com/chat/completions",maxTokens:8192,maxRequestBytes:8192,requestBodySha256:sha(body),requestBodyBytes:Buffer.byteLength(body),timeoutMs:60000,
    aiRuntimeSha256:guard.getNotesAiRuntimeSha256(),sourceSetSha256:"a".repeat(64),deadlineUtc:new Date(Date.now()+120000).toISOString()};
  const old=JSON.stringify(oldGuard.getTwoCallGuardState());
  guard.initializeNotesDispatchGuard(config);
  return {user,conv,notesJob,config,body,content,old,one,two,assistant};
}
function transport(config:NotesDispatchGuardConfig,body:string) {return {callKind:"private_notes",context:{jobId:config.jobId},provider:config.provider,model:config.model,endpoint:config.expectedEndpoint,maxTokens:8192,body,thinking:true,reasoningEffort:"high",timeoutMs:60000};}
async function terminal(f:Awaited<ReturnType<typeof setup>>) {
  await vi.waitFor(()=>expect(core.getPrivateJob(f.user.id,f.conv.id,f.notesJob.id)?.status).toMatch(/completed|failed|cancelled/),{timeout:5000});
  await vi.waitFor(()=>expect((globalThis as {__deepwePrivateBackgroundRunning?:boolean}).__deepwePrivateBackgroundRunning).not.toBe(true),{timeout:5000});
}
describe("persistent notes single dispatch",()=>{
  it("normal worker preserves closed P2, snapshots before one POST and durably commits notes",async()=>{
    const f=await setup();let snapshots=0;
    const original=persistence.persistDatabaseIfChanged;
    vi.spyOn(persistence,"persistDatabaseIfChanged").mockImplementation(async(force)=>{await original(force);snapshots++;});
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{expect(snapshots).toBeGreaterThan(0);expect(init?.body).toBe(f.body);expect(init?.redirect).toBe("error");return response(f.content);});vi.stubGlobal("fetch",fetch);
    worker.wakePrivateWorker();await terminal(f);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"completed",parent_post_count:14,parent_get_count:1,reserved_nano:16128000,worstCaseNano:151774725});
    expect(core.listCurrentNotes(f.conv.id)).toHaveLength(1);expect(fs.existsSync(path.join(fixtureDir,"persistent","deepwe.db"))).toBe(true);
    core.requeueInterruptedPrivateJobs();worker.wakePrivateWorker();await new Promise(resolve=>setTimeout(resolve,0));
    expect(fetch).toHaveBeenCalledTimes(1);expect(guard.getNotesDispatchGuardState()?.state).toBe("completed");
    expect(JSON.stringify(oldGuard.getTwoCallGuardState())).toBe(f.old);
  });
  it("atomic second reservation stops without refund; new scope and manual retry cannot reopen",async()=>{
    const f=await setup();expect(core.claimPrivateJob("background")?.id).toBe(f.notesJob.id);
    guard.reserveNotesDispatchTransport(transport(f.config,f.body));
    expect(()=>guard.reserveNotesDispatchTransport(transport(f.config,f.body))).toThrow(guard.NotesDispatchGuardError);
    core.failPrivateJob(f.notesJob.id);expect(core.retryJob(f.user.id,f.conv.id,f.notesJob.id)).toBeNull();
    expect(()=>guard.initializeNotesDispatchGuard({...f.config,scopeId:crypto.randomUUID()})).toThrow();
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",parent_post_count:14,reserved_nano:16128000});
    expect(JSON.stringify(oldGuard.getTwoCallGuardState())).toBe(f.old);
  });
  it("reserved restart is stopped, including cloned job UUID; no queue spin",async()=>{
    const f=await setup();core.claimPrivateJob("background");guard.reserveNotesDispatchTransport(transport(f.config,f.body));
    core.requeueInterruptedPrivateJobs();
    expect(core.getPrivateJob(f.user.id,f.conv.id,f.notesJob.id)?.status).toBe("failed");
    const clone=core.createNotesJob(f.user.id,f.conv.id)!;expect(clone.id).not.toBe(f.notesJob.id);
    expect(core.claimPrivateJob()).toBeUndefined();expect(core.privateJobsQueued()).toBe(false);
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",parent_post_count:14,reserved_nano:16128000});
  });
  it.each(["503","outer-json","notes-schema","source-fidelity","timeout"])("%s failure sends once and never retries after restart",async(kind)=>{
    const f=await setup();
    const fetch=vi.fn(async()=>{
      if(kind==="503")return new Response("fixture failure",{status:503});
      if(kind==="outer-json")return new Response("{",{status:200});
      if(kind==="notes-schema")return response('{"notes":{}}');
      if(kind==="source-fidelity")return response(JSON.stringify({notes:[{kind:"user_statement",content:"用户因对方晚到而失落。",sourceMessageIds:["missing-source"]}]}));
      const error=new Error("fixture timeout");error.name="AbortError";throw error;
    });vi.stubGlobal("fetch",fetch);worker.wakePrivateWorker();await terminal(f);
    expect(core.getPrivateJob(f.user.id,f.conv.id,f.notesJob.id)?.status).toBe("failed");
    core.requeueInterruptedPrivateJobs();worker.wakePrivateWorker();await new Promise(resolve=>setTimeout(resolve,0));
    expect(fetch).toHaveBeenCalledTimes(1);expect(core.retryJob(f.user.id,f.conv.id,f.notesJob.id)).toBeNull();
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",parent_post_count:14,reserved_nano:16128000});
    expect(core.listCurrentMessages(f.conv.id).find(message=>message.id===f.assistant.id)?.content).toBe(f.assistant.content);
    expect(JSON.stringify(oldGuard.getTwoCallGuardState())).toBe(f.old);
  });
  it("prefetch snapshot failure holds reservation and sends zero",async()=>{
    const f=await setup();vi.spyOn(persistence,"persistDatabaseIfChanged").mockRejectedValue(new Error("synthetic snapshot failure"));
    const fetch=vi.fn(async()=>response(f.content));vi.stubGlobal("fetch",fetch);worker.wakePrivateWorker();await terminal(f);
    expect(fetch).not.toHaveBeenCalled();expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",parent_post_count:14,reserved_nano:16128000});
    core.requeueInterruptedPrivateJobs();expect(core.claimPrivateJob()).toBeUndefined();
  });
  it("postcommit snapshot failure stops and retains the single consumed reservation",async()=>{
    const f=await setup();const original=persistence.persistDatabaseIfChanged;let calls=0;
    vi.spyOn(persistence,"persistDatabaseIfChanged").mockImplementation(async(force)=>{calls++;if(calls===3)throw new Error("synthetic final snapshot failure");await original(force);});
    const fetch=vi.fn(async()=>response(f.content));vi.stubGlobal("fetch",fetch);worker.wakePrivateWorker();await terminal(f);
    expect(fetch).toHaveBeenCalledTimes(1);expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",reserved_nano:16128000});
    core.requeueInterruptedPrivateJobs();expect(core.claimPrivateJob()).toBeUndefined();
  });
  it("whole request body drift cannot reach transport",async()=>{
    const f=await setup();core.claimPrivateJob("background");
    expect(()=>guard.reserveNotesDispatchTransport({...transport(f.config,f.body),body:f.body+" "})).toThrow();
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",parent_post_count:13,reserved_nano:0});
    expect(JSON.stringify(oldGuard.getTwoCallGuardState())).toBe(f.old);
  });
  it.each(["timeout","tokens","thinking","provider"])("%s profile drift is denied before dispatch",async(field)=>{
    const f=await setup();core.claimPrivateJob("background");
    const packet=transport(f.config,f.body);
    if(field==="timeout")packet.timeoutMs=1;
    if(field==="tokens")packet.maxTokens=8193;
    if(field==="thinking")packet.thinking=false;
    if(field==="provider")packet.provider="aihubmix";
    expect(()=>guard.reserveNotesDispatchTransport(packet)).toThrow();
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",parent_post_count:13,reserved_nano:0});
  });
  it("source changed during the prefetch snapshot is rechecked before any POST",async()=>{
    const f=await setup();const original=persistence.persistDatabaseIfChanged;let first=true;
    vi.spyOn(persistence,"persistDatabaseIfChanged").mockImplementation(async(force)=>{
      await original(force);
      if(first){first=false;db.prepare("UPDATE private_messages SET version=version+1 WHERE id=?").run(f.two.message.id);}
    });
    const fetch=vi.fn(async()=>response(f.content));vi.stubGlobal("fetch",fetch);worker.wakePrivateWorker();await terminal(f);
    expect(fetch).not.toHaveBeenCalled();expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",reserved_nano:16128000});
    expect(JSON.stringify(oldGuard.getTwoCallGuardState())).toBe(f.old);
  });
  it("late result after a current source edit cannot replace prior notes",async()=>{
    const f=await setup();let release!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;});
    const fetch=vi.fn(async()=>{await hold;return response(f.content);});vi.stubGlobal("fetch",fetch);
    worker.wakePrivateWorker();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
    expect(core.editUserMessage(f.user.id,f.conv.id,f.two.message.id,"更正：我仍然没有问清晚到原因。",f.config.inputVersion)).not.toHaveProperty("error");
    release();await terminal(f);
    expect(fetch).toHaveBeenCalledTimes(1);expect(core.listCurrentNotes(f.conv.id)).toEqual([]);
    expect(guard.getNotesDispatchGuardState()).toMatchObject({state:"stopped",reserved_nano:16128000});
    expect(core.claimPrivateJob()).toBeUndefined();expect(core.privateJobsQueued()).toBe(false);
  });
  it("source edit and other task kinds are ineligible; missing durable configuration is rejected",async()=>{
    const f=await setup();db.prepare("UPDATE private_messages SET version=version+1 WHERE id=?").run(f.one.message.id);
    expect(core.claimPrivateJob()).toBeUndefined();expect(core.privateJobsQueued()).toBe(false);
    expect(()=>guard.assertNotesDispatchStage("private_reply",{jobId:f.notesJob.id})).toThrow();
    db.prepare("DELETE FROM notes_dispatch_guard").run();vi.stubEnv("DEEPWE_PERSISTENT_DIR","");
    expect(()=>guard.initializeNotesDispatchGuard(f.config)).toThrow();expect(guard.getNotesDispatchGuardState()?.state).toBe("stopped");
  });
});
