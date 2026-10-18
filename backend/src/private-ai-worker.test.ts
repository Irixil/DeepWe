import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createUser, db } from "./db";
import * as core from "./private-core";
import { wakePrivateWorker } from "./private-ai-worker";

function aiResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function auditResponse(content: string): Response {
  return aiResponse(JSON.stringify({segments:[{kind:"narration",text:content}]}));
}

function replyOrAuditResponse(content: string, init?: RequestInit): Response {
  const request = JSON.parse(String(init?.body)) as {messages:Array<{content:string}>};
  return aiResponse(request.messages[0]?.content.includes("回复的来源与前提核对器")
    ? JSON.stringify({segments:[{kind:"narration",text:content}]}) : content);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("私密 worker 的时间与来源上下文", () => {
  it("核对失败时任务失败、首答不落库且日志不含模型正文", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
    const user=createUser(`${randomUUID()}@private-worker.test`,"合成核对失败用户","hash","salt");
    const conversation=core.createConversation(user.id);
    const draft="合成首答草稿，不得泄露";
    const rawProviderBody="合成模型错误正文，不得写入日志";
    const requests:Array<unknown>=[];
    const errorSpy=vi.spyOn(console,"error").mockImplementation(()=>undefined);
    vi.stubGlobal("fetch",vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      requests.push(JSON.parse(String(init?.body)));
      return requests.length===1?aiResponse(draft):new Response(rawProviderBody,{status:503});
    }));
    const source=core.addUserMessage(user.id,conversation.id,"合成用户原话")!;
    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getJobForSource(user.id,conversation.id,source.message.id)?.status).toBe("failed"),{timeout:3000});
    expect(requests).toHaveLength(2);
    expect(core.listCurrentMessages(conversation.id).filter(item=>item.role==="assistant")).toEqual([]);
    const logs=JSON.stringify(errorSpy.mock.calls);
    expect(logs).not.toContain(draft);
    expect(logs).not.toContain(rawProviderBody);
  });

  it("用户取消正在进行的来源核对后，迟到结果不落库", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
    const user=createUser(`${randomUUID()}@private-worker.test`,"合成取消核对用户","hash","salt");
    const conversation=core.createConversation(user.id);
    const draft="取消任务的合成首答草稿";
    let releaseAudit!:(response:Response)=>void;
    const pendingAudit=new Promise<Response>(resolve=>{releaseAudit=resolve;});
    let requestCount=0;
    vi.stubGlobal("fetch",vi.fn(async()=>++requestCount===1?aiResponse(draft):pendingAudit));
    const source=core.addUserMessage(user.id,conversation.id,"合成用户原话")!;
    wakePrivateWorker();
    await vi.waitFor(()=>expect(requestCount).toBe(2),{timeout:3000});
    expect(core.getJobForSource(user.id,conversation.id,source.message.id)?.status).toBe("processing");
    expect(core.cancelJob(user.id,conversation.id,source.jobId!)?.status).toBe("cancelled");
    releaseAudit(auditResponse("已取消任务的核对结果"));
    await vi.waitFor(()=>expect(requestCount).toBe(2),{timeout:3000});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(core.getJobForSource(user.id,conversation.id,source.message.id)?.status).toBe("cancelled");
    expect(core.listCurrentMessages(conversation.id).filter(item=>item.role==="assistant")).toEqual([]);
  });

  it("反馈派生风格偏好只进入原会话的下一轮", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
    const user=createUser(`${randomUUID()}@private-worker.test`,"合成偏好用户","hash","salt");
    const preferred=core.createConversation(user.id),isolated=core.createConversation(user.id);
    const first=core.addUserMessage(user.id,preferred.id,"第一条合成表达")!;
    core.cancelJob(user.id,preferred.id,first.jobId!);
    const oldAssistant=randomUUID();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`).run(oldAssistant,preferred.id,"旧合成回复",Date.now()+1);
    core.setLatestReplyFeedback(user.id,preferred.id,oldAssistant,"down","too_distant",first.conversationVersion);
    const next=core.addUserMessage(user.id,preferred.id,"继续的合成表达",randomUUID())!;
    const other=core.addUserMessage(user.id,isolated.id,"另一会话的合成表达",randomUUID())!;

    const requests:Array<{messages:Array<{role:string;content:string}>}> = [];
    vi.stubGlobal("fetch",vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {messages:Array<{role:string;content:string}>};
      requests.push(request);
      return request.messages[0]!.content.includes("当前有效理解")?aiResponse(JSON.stringify({notes:[]})):replyOrAuditResponse("我会接着听你说。",init);
    }));
    wakePrivateWorker();
    await vi.waitFor(()=>{
      expect(core.getJobForSource(user.id,preferred.id,next.message.id)?.status).toBe("completed");
      expect(core.getJobForSource(user.id,isolated.id,other.message.id)?.status).toBe("completed");
    },{timeout:3000});

    const packets=requests.map(request=>JSON.parse(request.messages[1]!.content) as {currentUserMessage?:{source?:{id:string}};personalPreferences?:string[]})
      .filter((packet):packet is {currentUserMessage:{source:{id:string}};personalPreferences:string[]}=>Boolean(packet.currentUserMessage?.source));
    expect(packets.find(packet=>packet.currentUserMessage.source.id===next.message.id)?.personalPreferences).toContain("本段潜谈偏好：自然承接愿意继续的表达，非必要不提醒暂停或不必展开");
    expect(packets.find(packet=>packet.currentUserMessage.source.id===other.message.id)?.personalPreferences).not.toContain("本段潜谈偏好：自然承接愿意继续的表达，非必要不提醒暂停或不必展开");
  });

  it("多条笔记排队且首条挂起时空前台通道不会空转", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
    const firstUser=createUser(`${randomUUID()}@private-worker.test`,"合成笔记用户甲","hash","salt");
    const secondUser=createUser(`${randomUUID()}@private-worker.test`,"合成笔记用户乙","hash","salt");
    const firstConversation=core.createConversation(firstUser.id);
    const secondConversation=core.createConversation(secondUser.id);
    const firstMessage=core.addUserMessage(firstUser.id,firstConversation.id,"第一条合成笔记来源")!;
    const secondMessage=core.addUserMessage(secondUser.id,secondConversation.id,"第二条合成笔记来源")!;
    core.cancelJob(firstUser.id,firstConversation.id,firstMessage.jobId!);
    core.cancelJob(secondUser.id,secondConversation.id,secondMessage.jobId!);
    const firstJob=core.createNotesJob(firstUser.id,firstConversation.id)!;
    const secondJob=core.createNotesJob(secondUser.id,secondConversation.id)!;
    let releaseFirst!:(response:Response)=>void;
    const blockedFirst=new Promise<Response>(resolve=>{releaseFirst=resolve;});
    let requestCount=0;
    vi.stubGlobal("fetch",vi.fn(async()=>++requestCount===1?blockedFirst:aiResponse(JSON.stringify({notes:[]}))));

    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getPrivateJob(firstUser.id,firstConversation.id,firstJob.id)?.status).toBe("processing"),{timeout:3000});
    expect(core.getPrivateJob(secondUser.id,secondConversation.id,secondJob.id)?.status).toBe("queued");
    await expect(new Promise<void>(resolve=>setTimeout(resolve,0))).resolves.toBeUndefined();

    releaseFirst(aiResponse(JSON.stringify({notes:[]})));
    await vi.waitFor(()=>expect(core.getPrivateJob(secondUser.id,secondConversation.id,secondJob.id)?.status).toBe("completed"),{timeout:3000});
    expect(requestCount).toBe(2);
  });

  it("笔记通道挂起时回复通道仍完成，旧版本笔记晚到结果不会落库", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
    const user=createUser(`${randomUUID()}@private-worker.test`,"合成并发用户","hash","salt");
    const conversation=core.createConversation(user.id);
    const first=core.addUserMessage(user.id,conversation.id,"第一条合成私密原话")!;
    core.cancelJob(user.id,conversation.id,first.jobId!);
    const refresh=core.createNotesJob(user.id,conversation.id)!;
    let releaseNotes!:(response:Response)=>void;
    const blockedNotes=new Promise<Response>(resolve=>{releaseNotes=resolve;});
    const requests:Array<{messages:Array<{role:string;content:string}>}>=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {messages:Array<{role:string;content:string}>};
      requests.push(request);
      if(requests.length===1)return blockedNotes;
      if(requests.length<=3)return replyOrAuditResponse("我会继续听你说。",init);
      return aiResponse(JSON.stringify({notes:[{kind:"user_statement",content:"有效的新版本笔记",sourceMessageIds:[first.message.id]}]}));
    }));
    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getPrivateJob(user.id,conversation.id,refresh.id)?.status).toBe("processing"),{timeout:3000});

    const next=core.addUserMessage(user.id,conversation.id,"第二条合成私密原话",randomUUID())!;
    wakePrivateWorker();
    await vi.waitFor(()=>expect(core.getJobForSource(user.id,conversation.id,next.message.id)?.status).toBe("completed"),{timeout:3000});
    expect(core.getPrivateJob(user.id,conversation.id,refresh.id)?.status).toBe("cancelled");
    expect(core.listCurrentMessages(conversation.id).some(item=>item.role==="assistant"&&item.content==="我会继续听你说。")).toBe(true);

    releaseNotes(aiResponse(JSON.stringify({notes:[{kind:"user_statement",content:"不应写入的旧版本笔记",sourceMessageIds:[first.message.id]}]})));
    await vi.waitFor(()=>expect(core.listCurrentNotes(conversation.id).some(item=>item.content==="有效的新版本笔记")).toBe(true),{timeout:3000});
    expect(core.listCurrentNotes(conversation.id).some(item=>item.content==="不应写入的旧版本笔记")).toBe(false);
    expect(requests).toHaveLength(4);
  });

  it("本人纠正后的笔记只以替代内容进入回复和下次笔记刷新", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
    const user=createUser(`${randomUUID()}@private-worker.test`,"合成纠正用户","hash","salt");
    const conversation=core.createConversation(user.id);
    const source=core.addUserMessage(user.id,conversation.id,"我还没确认她答应了什么。")!;
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    const noteId=randomUUID();
    db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
      VALUES(?,?,'tentative_understanding','旧错误理解：她已经答应了。',?,?,?,1,'current',?)`).run(
      noteId,conversation.id,JSON.stringify([source.message.id]),JSON.stringify({[source.message.id]:source.message.version}),source.conversationVersion,Date.now(),
    );
    expect(core.correctNote(user.id,conversation.id,noteId,"本人纠正：我不知道她是否答应",1)).not.toHaveProperty("error");
    core.addUserMessage(user.id,conversation.id,"请按我刚才的纠正继续。",randomUUID());

    const requests:Array<{messages:Array<{role:string;content:string}>}>=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body)) as {messages:Array<{role:string;content:string}>};
      requests.push(request);
      return requests.length<=2 ? replyOrAuditResponse("我会按你纠正后的理解继续。",init) : aiResponse(JSON.stringify({notes:[{kind:"user_statement",content:"本人不知道她是否答应。",sourceMessageIds:[source.message.id]}]}));
    }));
    wakePrivateWorker();
    await vi.waitFor(()=>{
      const jobs=db.prepare(`SELECT kind,status FROM private_jobs WHERE conversation_id=? AND status!='cancelled' ORDER BY rowid`).all(conversation.id) as Array<{kind:string;status:string}>;
      expect(jobs.map(item=>[item.kind,item.status])).toEqual([["reply","completed"],["notes","completed"]]);
    },{timeout:3000});
    expect(requests).toHaveLength(3);
    for(const request of requests) {
      const prompt=JSON.stringify(request.messages);
      expect(prompt).toContain("本人纠正：我不知道她是否答应");
      expect(prompt).not.toContain("旧错误理解：她已经答应了");
    }
  });

  it("回复和笔记请求都传递原话来源时刻，不传笔记更新时间或推测用户时区", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");

    const user = createUser(`${randomUUID()}@private-worker.test`, "合成用户", "hash", "salt");
    const conversation = core.createConversation(user.id);
    const firstId = randomUUID();
    const secondId = randomUUID();
    const assistantId = randomUUID();
    const firstTime = Date.parse("2026-09-28T14:00:00.000Z");
    const secondTime = Date.parse("2026-09-28T14:03:00.000Z");
    const currentTime = Date.parse("2026-09-29T10:10:00.000Z");
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'user', ?,1,'current',?)`)
      .run(firstId, conversation.id, "合成的早先原话甲。", firstTime);
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'user', ?,1,'current',?)`)
      .run(secondId, conversation.id, "合成的早先原话乙。", secondTime);
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`)
      .run(assistantId, conversation.id, "合成的旧助手解释。", secondTime + 1000);

    const source = core.addUserMessage(user.id, conversation.id, "请继续帮我整理。", randomUUID())!;
    db.prepare(`UPDATE private_messages SET created_at=? WHERE id=?`).run(currentTime, source.message.id);
    const noteUpdatedAt = currentTime + 60_000;
    db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
      VALUES(?,?, 'user_statement', ?, ?, ?, ?,1,'current',?)`).run(
      randomUUID(), conversation.id, "合成来源笔记。", JSON.stringify([firstId, secondId]),
      JSON.stringify({ [firstId]: 1, [secondId]: 1 }), core.getConversationById(user.id, conversation.id)!.version, noteUpdatedAt,
    );

    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      requests.push(request);
      return requests.length <= 2 ? replyOrAuditResponse("我会按你之前说过的内容继续整理。",init)
        : aiResponse(JSON.stringify({ notes: [{ kind: "user_statement", content: "合成笔记记录。", sourceMessageIds: [firstId] }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    wakePrivateWorker();
    await vi.waitFor(() => {
      const jobs = db.prepare(`SELECT kind,status FROM private_jobs WHERE conversation_id=? ORDER BY rowid`).all(conversation.id) as Array<{ kind: string; status: string }>;
      expect(jobs).toHaveLength(2);
      expect(jobs.map(job => job.status)).toEqual(["completed", "completed"]);
    }, { timeout: 3000 });

    expect(requests).toHaveLength(3);
    const replyPrompt = requests[0]!.messages[0]!.content;
    const replyPacket = JSON.parse(requests[0]!.messages[1]!.content);
    expect(replyPacket.conversationHistory).toContainEqual(expect.objectContaining({sourceId:firstId,version:1,originalCreatedAtUtc:"2026-09-28T14:00:00.000Z"}));
    expect(replyPacket.conversationHistory).toContainEqual(expect.objectContaining({sourceId:secondId,version:1,originalCreatedAtUtc:"2026-09-28T14:03:00.000Z"}));
    expect(replyPacket.currentUserMessage.source).toMatchObject({id:source.message.id,version:1,originalCreatedAtUtc:"2026-09-29T10:10:00.000Z"});
    expect(replyPacket.privateNotes).toEqual([]);
    expect(JSON.stringify(replyPacket)).not.toContain("合成来源笔记。");
    expect(replyPacket.conversationHistory).toContainEqual(expect.objectContaining({sourceId:assistantId,speaker:"assistant",originalCreatedAtUtc:null}));
    expect(JSON.stringify(replyPacket)).not.toContain('"updatedAt"');
    expect(replyPrompt).toContain("originalCreatedAtUtc 是消息首次创建时间");
    expect(replyPrompt).toContain("version>1 的编辑版本不得用首次创建时间或当前日期换算");
    expect(replyPrompt).toContain("privateNotes.sourceMessageIds 只表示出处");

    const notesPrompt = requests[2]!.messages[0]!.content;
    const notesPacket = JSON.parse(requests[2]!.messages[1]!.content);
    expect(notesPacket.userMessagesInOrder).toContainEqual(expect.objectContaining({id:firstId,version:1,originalCreatedAtUtc:"2026-09-28T14:00:00.000Z"}));
    expect(notesPacket.userMessagesInOrder).toContainEqual(expect.objectContaining({id:secondId,version:1,originalCreatedAtUtc:"2026-09-28T14:03:00.000Z"}));
    expect(notesPacket.userMessagesInOrder).toContainEqual(expect.objectContaining({id:source.message.id,version:1,originalCreatedAtUtc:"2026-09-29T10:10:00.000Z"}));
    expect(notesPrompt).toContain("version>1 的编辑时刻未知");
    expect(notesPrompt).toContain("更正只覆盖用户指明的部分");
    expect(JSON.stringify(notesPacket)).not.toContain(assistantId);
    expect(JSON.stringify(notesPacket)).not.toContain('"updatedAt"');
  });

  it("隔日编辑旧消息后，把版本与首次创建时间分开传入回复和笔记请求", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");

    const user = createUser(`${randomUUID()}@private-worker.test`, "合成编辑用户", "hash", "salt");
    const conversation = core.createConversation(user.id);
    let clock = Date.parse("2026-09-28T14:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const history = core.addUserMessage(user.id, conversation.id, "合成历史原话。", randomUUID())!;
    clock = Date.parse("2026-09-28T14:05:00.000Z");
    const original = core.addUserMessage(user.id, conversation.id, "我那天觉得很难受。", randomUUID())!;
    db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
      VALUES(?,?, 'user_statement', ?, ?, ?, ?,1,'current',?)`).run(
      randomUUID(), conversation.id, "合成历史笔记。", JSON.stringify([history.message.id]),
      JSON.stringify({ [history.message.id]: 1 }), original.conversationVersion, clock,
    );

    clock = Date.parse("2026-09-29T10:10:00.000Z");
    const edited = core.editUserMessage(user.id, conversation.id, original.message.id, "我想修正那条旧消息：今天我其实还没有决定。", original.conversationVersion);
    expect("error" in edited).toBe(false);
    if ("error" in edited) throw new Error(`编辑失败：${edited.error}`);
    expect(edited.message.version).toBe(2);
    expect(edited.message.createdAt).toBe(Date.parse("2026-09-28T14:05:00.000Z"));

    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      requests.push(request);
      return requests.length <= 2 ? replyOrAuditResponse("我会按你之前提到的内容继续。",init)
        : aiResponse(JSON.stringify({ notes: [{ kind: "user_statement", content: "合成编辑后的笔记。", sourceMessageIds: [original.message.id] }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    wakePrivateWorker();
    await vi.waitFor(() => {
      const jobs = db.prepare(`SELECT kind,status FROM private_jobs WHERE conversation_id=? AND status!='cancelled' ORDER BY rowid`).all(conversation.id) as Array<{ kind: string; status: string }>;
      expect(jobs.map(job => [job.kind, job.status])).toEqual([["reply", "completed"], ["notes", "completed"]]);
    }, { timeout: 3000 });

    expect(requests).toHaveLength(3);
    const replyPrompt = requests[0]!.messages[0]!.content;
    const replyPacket = JSON.parse(requests[0]!.messages[1]!.content);
    expect(replyPacket.conversationHistory).toContainEqual(expect.objectContaining({sourceId:history.message.id,version:1}));
    expect(replyPacket.currentUserMessage.source).toMatchObject({id:original.message.id,version:2,originalCreatedAtUtc:"2026-09-28T14:05:00.000Z"});
    expect(replyPrompt).toContain("originalCreatedAtUtc 是消息首次创建时间");
    expect(replyPrompt).toContain("version>1 的编辑版本不得用首次创建时间或当前日期换算");
    expect(replyPacket.privateNotes).toEqual([]);
    expect(JSON.stringify(replyPacket)).not.toContain("合成历史笔记。");

    const notesPrompt = requests[2]!.messages[0]!.content;
    const notesPacket = JSON.parse(requests[2]!.messages[1]!.content);
    expect(notesPacket.userMessagesInOrder).toContainEqual(expect.objectContaining({id:history.message.id,version:1}));
    expect(notesPacket.userMessagesInOrder).toContainEqual(expect.objectContaining({id:original.message.id,version:2,originalCreatedAtUtc:"2026-09-28T14:05:00.000Z"}));
    expect(notesPrompt).toContain("version>1 的编辑时刻未知，不能用首次创建时间推断编辑内容的日期或月份");
  });
});
