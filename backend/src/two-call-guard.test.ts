import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { createUser, db } from "./db";
import * as core from "./private-core";
import { wakePrivateWorker } from "./private-ai-worker";
import * as persistence from "./persistence";
import { initializeTwoCallGuard, getTwoCallGuardState, getTwoCallAiRuntimeSha256,
  reserveTwoCallTransport, assertTwoCallStage, TwoCallGuardError,
  type TwoCallGuardConfig } from "./two-call-guard";

beforeEach(()=>{ db.prepare("DELETE FROM two_call_guard_phases").run(); db.prepare("DELETE FROM two_call_guard").run(); });
afterEach(()=>{ vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function setup(parentHistory?: "closed_n1_20261010") {
  const user=createUser(`${crypto.randomUUID()}@two-call.test`,"合成两阶段用户","hash","salt");
  const conversation=core.createConversation(user.id);
  const text="我想把这件事再说清楚一点。";
  const config:TwoCallGuardConfig={...(parentHistory?{parentHistory}:{}),scopeId:crypto.randomUUID(),ownerUserId:user.id,conversationId:conversation.id,
    nextMessageSha256:crypto.createHash("sha256").update(text).digest("hex"),inputVersion:conversation.version+1,
    sourceMessageVersion:1,provider:"deepseek",model:"deepseek-v4-flash",expectedEndpoint:"https://api.deepseek.com/chat/completions",
    maxTokens:8192,replyMaxRequestBytes:16384,auditMaxRequestBytes:32768,aiRuntimeSha256:getTwoCallAiRuntimeSha256(),
    sourceSetSha256:"a".repeat(64),deadlineUtc:new Date(Date.now()+60000).toISOString()};
  initializeTwoCallGuard(config);
  const source=core.addUserMessage(user.id,conversation.id,text)!;
  return {user,conversation,config,source};
}
function transport(jobId:string,phase:"reply"|"audit") {
  return {callKind:"private_reply",context:{jobId},phase,provider:"deepseek",model:"deepseek-v4-flash",
    endpoint:"https://api.deepseek.com/chat/completions",maxTokens:8192,requestBytes:1000,
    thinking:true,reasoningEffort:"high",timeoutMs:35000};
}
function response(text:string) { return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:text}}]}),{status:200}); }

describe("持久两阶段产品保护",()=>{
  it("从已关N1实际父14/1接续，不释放历史unknown或重新记成11",()=>{
    setup("closed_n1_20261010");const job=core.claimPrivateJob("foreground")!;
    expect(getTwoCallGuardState()).toMatchObject({parent_post_count:14,parent_get_count:1,known_nano:72051375,
      unknown_nano_1:16341375,unknown_nano_2:52278600,worstCaseNano:140671350});
    reserveTwoCallTransport(transport(job.id,"reply"));
    expect(getTwoCallGuardState()).toMatchObject({parent_post_count:15,reserved_nano:19200000,worstCaseNano:159871350});
  });

  it("从正常下一条消息绑定来源和实际任务，保持父历史分项",()=>{
    const {source}=setup();
    const job=core.claimPrivateJob("foreground")!;
    expect(job.id).toBe(source.jobId);
    expect(getTwoCallGuardState()).toMatchObject({job_id:job.id,source_message_id:source.message.id,parent_post_count:11,parent_get_count:1,
      known_nano:59610375,unknown_nano_1:16341375,unknown_nano_2:52278600,worstCaseNano:128230350});
    reserveTwoCallTransport(transport(job.id,"reply"));
    expect(getTwoCallGuardState()).toMatchObject({parent_post_count:12,reserved_nano:19200000,worstCaseNano:147430350});
  });
  it("同阶段原子预占不可重复，失败也不回收",()=>{
    setup(); const job=core.claimPrivateJob()!;
    reserveTwoCallTransport(transport(job.id,"reply"));
    expect(()=>reserveTwoCallTransport(transport(job.id,"reply"))).toThrow(TwoCallGuardError);
    expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:12,reserved_nano:19200000});
    expect(getTwoCallGuardState()?.phases).toHaveLength(1);
  });
  it("audit不能在reply成功前发送，中央入口拒绝其他stage及无任务调用",()=>{
    setup(); const job=core.claimPrivateJob()!;
    expect(()=>assertTwoCallStage("private_notes",{jobId:job.id},"reply")).toThrow(TwoCallGuardError);
    expect(()=>assertTwoCallStage("private_reply",undefined,"reply")).toThrow(TwoCallGuardError);
    expect(()=>reserveTwoCallTransport(transport(job.id,"audit"))).toThrow(TwoCallGuardError);
    expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:11,reserved_nano:0});
  });
  it("换scope或hash不能重新初始化父预算",()=>{
    const {config}=setup(); const job=core.claimPrivateJob()!;
    reserveTwoCallTransport(transport(job.id,"reply"));
    expect(()=>initializeTwoCallGuard({...config,scopeId:crypto.randomUUID(),nextMessageSha256:"b".repeat(64)})).toThrow(TwoCallGuardError);
    expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:12,reserved_nano:19200000});
  });
  it("配置错误留下持久关闭状态，不回到默认无保护路径",()=>{
    const {config}=setup(); db.prepare("DELETE FROM two_call_guard").run();
    expect(()=>initializeTwoCallGuard({...config,maxTokens:8193} as unknown as TwoCallGuardConfig)).toThrow(TwoCallGuardError);
    expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:11,reserved_nano:0,error_code:"INVALID_CONFIG"});
    expect(()=>assertTwoCallStage("router")).toThrow(TwoCallGuardError);
  });
  it("运行时空配置也留下关闭状态",()=>{
    expect(()=>initializeTwoCallGuard(null as unknown as TwoCallGuardConfig)).toThrow(TwoCallGuardError);
    expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:11,error_code:"INVALID_CONFIG"});
    expect(()=>assertTwoCallStage("router")).toThrow(TwoCallGuardError);
  });
  it("已预占的processing重启失败停，不允许新UUID重试",()=>{
    const {user,conversation,source}=setup(); const job=core.claimPrivateJob()!;
    reserveTwoCallTransport(transport(job.id,"reply"));
    core.requeueInterruptedPrivateJobs();
    expect(core.getPrivateJob(user.id,conversation.id,job.id)?.status).toBe("failed");
    expect(core.retryJob(user.id,conversation.id,source.jobId!)).toBeNull();
    expect(core.claimPrivateJob()).toBeUndefined();
    expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:12,reserved_nano:19200000});
  });
  it("正常worker仅reply和audit，入库后notes保持queued且重启不破坏completed",async()=>{
    vi.stubEnv("DEEPSEEK_API_KEY","synthetic-test-key");vi.stubEnv("DEEPWE_PRIVATE_PROVIDER","deepseek");
    const {user,conversation,source}=setup();
    const fetch=vi.fn(async()=>response("你可以继续说说你想澄清的部分。"));vi.stubGlobal("fetch",fetch);
    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getPrivateJob(user.id,conversation.id,source.jobId!)?.status).toBe("completed"),{timeout:3000});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getTwoCallGuardState()).toMatchObject({state:"completed",parent_post_count:13,parent_get_count:1,reserved_nano:44544000,worstCaseNano:172774350});
    expect(db.prepare("SELECT status FROM private_jobs WHERE conversation_id=? AND kind='notes'").all(conversation.id)).toEqual([{status:"queued"}]);
    expect(core.privateJobsQueued("background")).toBe(false);
    core.requeueInterruptedPrivateJobs();wakePrivateWorker();
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(fetch).toHaveBeenCalledTimes(2);expect(getTwoCallGuardState()?.state).toBe("completed");
  });
  it("发送前快照比模型timeout慢时仍只在保存后启动网络定时器",async()=>{
    vi.stubEnv("DEEPSEEK_API_KEY","synthetic-test-key");vi.stubEnv("DEEPWE_PRIVATE_PROVIDER","deepseek");
    vi.stubEnv("DEEPWE_PRIVATE_TIMEOUT_MS","10");
    const {user,conversation,source}=setup();
    let completedSnapshots=0;
    vi.spyOn(persistence,"persistDatabaseIfChanged").mockImplementation(async()=>{
      await new Promise(resolve=>setTimeout(resolve,60));
      completedSnapshots+=1;
    });
    const observed:Array<{snapshotCount:number;aborted:boolean}> = [];
    const fetch=vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      observed.push({snapshotCount:completedSnapshots,aborted:Boolean(init?.signal?.aborted)});
      return response("你可以继续说说你想澄清的部分。");
    });vi.stubGlobal("fetch",fetch);
    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getPrivateJob(user.id,conversation.id,source.jobId!)?.status).toBe("completed"),{timeout:3000});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([{snapshotCount:1,aborted:false},{snapshotCount:3,aborted:false}]);
    expect(getTwoCallGuardState()).toMatchObject({state:"completed",parent_post_count:13,reserved_nano:44544000});
    // Let the worker's finally finish before restoring the persistence spy.
    await vi.waitFor(()=>expect(completedSnapshots).toBe(5),{timeout:3000});
  });
  it("reply首次503后不自动重试，重启不增加发送",async()=>{
    vi.stubEnv("DEEPSEEK_API_KEY","synthetic-test-key");vi.stubEnv("DEEPWE_PRIVATE_PROVIDER","deepseek");
    vi.spyOn(console,"error").mockImplementation(()=>undefined);
    const {user,conversation,source}=setup();
    const fetch=vi.fn(async()=>new Response("synthetic failure",{status:503}));vi.stubGlobal("fetch",fetch);
    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getPrivateJob(user.id,conversation.id,source.jobId!)?.status).toBe("failed"),{timeout:3000});
    core.requeueInterruptedPrivateJobs();wakePrivateWorker();await new Promise(resolve=>setTimeout(resolve,0));
    expect(fetch).toHaveBeenCalledTimes(1);expect(getTwoCallGuardState()).toMatchObject({state:"stopped",parent_post_count:12,reserved_nano:19200000});
  });
});
