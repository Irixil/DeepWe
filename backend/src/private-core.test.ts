import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createEvent, createUser, db, deleteEventCompletely, recordAiCallMetric } from "./db";
import * as core from "./private-core";

function actor() {
  return createUser(`${randomUUID()}@private-core.test`, "合成会话用户", "hash", "salt", false);
}

function addNote(conversationId:string,messageId:string,sourceVersion=1) {
  const noteId=randomUUID();
  const conversationVersion=core.getConversationById(actorIdForConversation(conversationId),conversationId)?.version??1;
  db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
    VALUES(?,?,'user_statement','合成笔记',?,?,?,1,'current',?)`).run(noteId,conversationId,JSON.stringify([messageId]),JSON.stringify({[messageId]:sourceVersion}),conversationVersion,Date.now());
  return noteId;
}

function actorIdForConversation(conversationId:string):string {
  return (db.prepare(`SELECT owner_user_id FROM private_conversations WHERE id=?`).get(conversationId) as {owner_user_id:string}).owner_user_id;
}

describe("私密会话风险和恢复 DTO", () => {
  it("同一账号的创建请求编号幂等，删除后不复活且不同账号隔离", () => {
    const user=actor(),other=actor(),requestId=randomUUID();
    const first=core.createConversationWithRequestId(user.id,"首次标题",requestId);
    const retry=core.createConversationWithRequestId(user.id,"重试标题",requestId);
    expect(first).toMatchObject({created:true,retired:false});
    expect(retry).toMatchObject({created:false,retired:false,conversation:{id:first.conversation!.id,title:"首次标题"}});
    const otherAccount=core.createConversationWithRequestId(other.id,"另一账号",requestId);
    expect(otherAccount.created).toBe(true);
    expect(otherAccount.conversation?.id).not.toBe(first.conversation?.id);
    expect(core.createConversation(user.id).id).not.toBe(first.conversation?.id);

    expect(core.deleteConversation(user.id,first.conversation!.id)).toBe(true);
    expect(core.createConversationWithRequestId(user.id,"不可恢复",requestId)).toEqual({conversation:null,created:false,retired:true});
    expect((db.prepare(`SELECT COUNT(*) count FROM private_conversations WHERE owner_user_id=? AND client_request_id=?`).get(user.id,requestId) as {count:number}).count).toBe(1);
    expect(core.getConversationById(user.id,first.conversation!.id)).toBeNull();
  });

  it("笔记来源只是出处，不会从长对话上下文中吞掉未被笔记复述的原话", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    const first=core.addUserMessage(user.id,conversation.id,"那次我明确说了：我没听见她答应；她当时也没有回复。")!;
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    for(let index=1;index<13;index++) {
      core.addUserMessage(user.id,conversation.id,`后续合成消息 ${index}`);
      db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    }
    addNote(conversation.id,first.message.id);
    const context=core.getReplyContext(conversation.id);
    expect(context.notes.some(item=>item.sourceMessageIds.includes(first.message.id))).toBe(true);
    expect(context.history.find(item=>item.id===first.message.id)?.content).toContain("她当时也没有回复");
  });

  it("分享草稿原话按服务端消息时间排序，不跟随请求里的ID排列", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    const first=core.addUserMessage(user.id,conversation.id,"较早的合成原话")!;
    const second=core.addUserMessage(user.id,conversation.id,"较晚的合成原话")!;
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    db.prepare(`UPDATE private_messages SET created_at=? WHERE id=?`).run(100,first.message.id);
    db.prepare(`UPDATE private_messages SET created_at=? WHERE id=?`).run(200,second.message.id);
    expect(core.getShareDraftSources(conversation.id,[second.message.id,first.message.id]).map(item=>item.id)).toEqual([first.message.id,second.message.id]);
  });

  it("重复请求同一失败任务的重试会复用一个queued任务", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"合成消息")!;
    db.prepare(`UPDATE private_jobs SET status='failed' WHERE id=?`).run(source.jobId);
    const first=core.retryJob(user.id,conversation.id,source.jobId!)!;
    const second=core.retryJob(user.id,conversation.id,source.jobId!)!;
    expect(second.id).toBe(first.id);
    expect(db.prepare(`SELECT COUNT(*) count FROM private_jobs WHERE conversation_id=? AND status='queued'`).get(conversation.id)).toEqual({count:1});
    expect(core.getConversationDetail(user.id,conversation.id)?.pendingJob?.id).toBe(first.id);
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=?`).run(first.id);
    expect(core.completePrivateJob(first.id,{reply:"合成恢复回复"})).toBe(true);
    const recovered=core.getConversationDetail(user.id,conversation.id)!;
    expect(recovered.pendingJob).toBeNull();
    expect(recovered.jobs.find(item=>item.kind==="reply")).toMatchObject({id:first.id,status:"completed"});
    expect(recovered.messages.filter(item=>item.role==="user")).toHaveLength(1);
    expect(recovered.messages.filter(item=>item.role==="assistant")).toHaveLength(1);
  });

  it("同一会话版本的笔记刷新请求复用queued任务", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    const first=core.createNotesJob(user.id,conversation.id)!;
    const second=core.createNotesJob(user.id,conversation.id)!;
    expect(second.id).toBe(first.id);
    expect(db.prepare(`SELECT COUNT(*) count FROM private_jobs WHERE conversation_id=? AND kind='notes' AND status IN ('queued','processing')`).get(conversation.id)).toEqual({count:1});
  });

  it("claim 会在生成前取消输入版本已经过期的任务", () => {
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"合成消息")!;
    db.prepare(`UPDATE private_jobs SET input_version=input_version-1 WHERE id=?`).run(source.jobId);
    expect(core.claimPrivateJob()).toBeUndefined();
    expect(core.getPrivateJob(user.id,conversation.id,source.jobId!)?.status).toBe("cancelled");
  });

  it("会话删除会清除processing任务，晚到结果无法复活内容", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"合成私密原话")!;
    const claimed=core.claimPrivateJob()!;
    expect(claimed.id).toBe(source.jobId);
    expect(core.deleteConversation(user.id,conversation.id)).toBe(true);
    expect(core.completePrivateJob(source.jobId!,{reply:"不应写回的晚到结果"})).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) count FROM private_messages WHERE conversation_id=?`).get(conversation.id) as {count:number}).count).toBe(0);
    expect(core.getConversationById(user.id,conversation.id)).toBeNull();
  });

  it("撤回processing任务会阻止结果落库", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"合成私密原话")!;
    const claimed=core.claimPrivateJob()!;
    expect(claimed.id).toBe(source.jobId);
    expect(core.cancelJob(user.id,conversation.id,source.jobId!)?.status).toBe("cancelled");
    expect(core.completePrivateJob(source.jobId!,{reply:"不应写回的撤回结果"})).toBe(false);
    expect(core.listCurrentMessages(conversation.id).map(item=>item.content)).toEqual(["合成私密原话"]);
  });

  it("空白笔记纠正被拒绝且不会推进会话版本或覆盖纠正", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"合成表达")!;
    const noteId=addNote(conversation.id,source.message.id);
    const version=core.getConversationById(user.id,conversation.id)!.version;
    expect(core.correctNote(user.id,conversation.id,noteId," \n ",1)).toEqual({error:"empty_correction"});
    expect(core.getConversationById(user.id,conversation.id)!.version).toBe(version);
    expect(core.listCurrentNotes(conversation.id).find(item=>item.id===noteId)).not.toHaveProperty("correction");
  });

  it("风险来源跨轮保留、阻断分享；明确安全转折后解除", () => {
    const user = actor();
    const conversation = core.createConversation(user.id);
    const first = core.addUserMessage(user.id, conversation.id, "他说要掐我，还堵住门不让我出去。")!;
    expect(core.getConversationDetail(user.id, conversation.id)?.conversation.safetyStatus).toBe("active");
    core.addUserMessage(user.id, conversation.id, "我想先把事情讲清楚。", randomUUID());
    expect(core.getConversationDetail(user.id, conversation.id)?.conversation.safetyStatus).toBe("active");
    expect(core.createShareDraftJob(user.id, conversation.id, [first.message.id])).toBe(false);

    const safe = core.addUserMessage(user.id, conversation.id, "我现在安全，已经离开住处，有朋友陪着我。", randomUUID())!;
    expect(core.getConversationDetail(user.id, conversation.id)?.conversation.safetyStatus).toBe("clear");
    expect(core.createShareDraftJob(user.id, conversation.id, [safe.message.id])).not.toBe(false);
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);

    const ongoing=core.createConversation(user.id);
    const threat=core.addUserMessage(user.id,ongoing.id,"前男友刚才砸了我的杯子，说我敢走就去我住的地方找我。我已经离开他家，现在暂时在姐姐家。")!;
    const exposure=core.addUserMessage(user.id,ongoing.id,"他还能看到我手机的位置共享。")!;
    for(let i=0;i<14;i++)core.addUserMessage(user.id,ongoing.id,"我想安静一会儿。",randomUUID());
    core.addUserMessage(user.id,ongoing.id,"我现在安全，已经离开他家。",randomUUID());
    expect(core.getConversationDetail(user.id,ongoing.id)?.conversation.safetyStatus).toBe("active");
    expect(core.getActiveRiskMessages(user.id,ongoing.id).map(item=>item.id)).toEqual([threat.message.id,exposure.message.id]);
    expect(core.createShareDraftJob(user.id,ongoing.id,[threat.message.id])).toBe(false);
    core.addUserMessage(user.id,ongoing.id,"他已经看不到我的定位，我现在安全了。",randomUUID());
    expect(core.getConversationDetail(user.id,ongoing.id)?.conversation.safetyStatus).toBe("clear");
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(ongoing.id);
  });

  it("风险出现后不能确认此前已生成的分享草稿", () => {
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const user = actor();
    const conversation = core.createConversation(user.id);
    const source = core.addUserMessage(user.id, conversation.id, "一件普通的合成事件。")!;
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    const started = core.createShareDraftJob(user.id, conversation.id, [source.message.id]);
    expect(started).not.toBe(false);
    if (!started) throw new Error("share job not created");
    const claimed = core.claimPrivateJob();
    expect(claimed?.id).toBe(started.jobId);
    expect(core.completePrivateJob(started.jobId, { content: "经本人核对的合成摘要" })).toBe(true);
    core.addUserMessage(user.id, conversation.id, "他现在威胁我，不让我离开。", randomUUID());
    expect(core.confirmShareDraft(user.id, conversation.id, started.draftId, 1)).toEqual({ error: "active_risk" });
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
  });

  it("堵着门且不让用户出去会阻断分享草稿", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    core.addUserMessage(user.id,conversation.id,"不过我想起来，他之前堵着门不让我出去，说不说清楚就不能走。");
    expect(core.getConversationDetail(user.id,conversation.id)?.conversation.safetyStatus).toBe("active");
    expect(core.createShareDraftJob(user.id,conversation.id,[core.getConversationDetail(user.id,conversation.id)!.messages[0].id])).toBe(false);
  });

  it("来源被编辑后，过期笔记不能纠正或被晚到刷新复活", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"原始合成表达")!;
    const noteId=addNote(conversation.id,source.message.id);
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const refresh=core.createNotesJob(user.id,conversation.id)!;
    expect(core.claimPrivateJob()?.id).toBe(refresh.id);
    const version=core.getConversationById(user.id,conversation.id)!.version;
    expect(core.editUserMessage(user.id,conversation.id,source.message.id,"修订后的合成表达",version)).not.toHaveProperty("error");
    const noteVersion=(db.prepare(`SELECT version FROM private_notes WHERE id=?`).get(noteId) as {version:number}).version;
    expect(core.correctNote(user.id,conversation.id,noteId,"不应保存的旧纠正",noteVersion)).toEqual({error:"stale"});
    expect(core.completePrivateJob(refresh.id,[{kind:"user_statement",content:"晚到的旧理解",sourceMessageIds:[source.message.id]}])).toBe(false);
    expect(core.listCurrentNotes(conversation.id).some(item=>item.id===noteId||item.content==="晚到的旧理解")).toBe(false);
  });

  it("来源删除后笔记无法纠正，来源版本失效的笔记不会进入上下文", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"将删除的合成表达")!;
    const noteId=addNote(conversation.id,source.message.id);
    expect(core.deleteUserMessage(user.id,conversation.id,source.message.id,core.getConversationById(user.id,conversation.id)!.version)).toBe("ok");
    expect(core.correctNote(user.id,conversation.id,noteId,"不应复活",1)).toEqual({error:"not_found"});
    expect(core.listCurrentNotes(conversation.id).some(item=>item.id===noteId)).toBe(false);

    const orphanSource=core.addUserMessage(user.id,conversation.id,"待验证来源的合成表达")!;
    const orphanNote=addNote(conversation.id,orphanSource.message.id);
    db.prepare(`DELETE FROM private_messages WHERE id=?`).run(orphanSource.message.id);
    expect(core.correctNote(user.id,conversation.id,orphanNote,"不应从缺失来源写入",1)).toEqual({error:"stale"});
    expect(core.listCurrentNotes(conversation.id).some(item=>item.id===orphanNote)).toBe(false);

    const current=core.addUserMessage(user.id,conversation.id,"仍有效的合成表达")!;
    const invalidVersionNote=addNote(conversation.id,current.message.id,current.message.version+1);
    expect(core.correctNote(user.id,conversation.id,invalidVersionNote,"不应保存",1)).toEqual({error:"stale"});
    expect(core.listCurrentNotes(conversation.id).some(item=>item.id===invalidVersionNote)).toBe(false);
  });

  it("反馈只作用于最新一轮，并以固定原因生成可撤回的会话偏好", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    const first=core.addUserMessage(user.id,conversation.id,"合成的旧表达")!;
    const second=core.addUserMessage(user.id,conversation.id,"合成的最新表达")!;
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
    const oldAssistant=randomUUID(),assistant=randomUUID();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`).run(oldAssistant,conversation.id,"旧合成回复",Date.now()+1);
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`).run(assistant,conversation.id,"最新合成回复",Date.now()+2);
    expect(core.editUserMessage(user.id,conversation.id,first.message.id,"不能改历史",second.conversationVersion)).toMatchObject({error:"not_latest"});
    expect(core.deleteUserMessage(user.id,conversation.id,first.message.id,second.conversationVersion)).toBe("not_latest");
    expect(core.setLatestReplyFeedback(user.id,conversation.id,oldAssistant,"up","clear",second.conversationVersion)).toEqual({error:"not_latest"});
    expect(core.setLatestReplyFeedback(user.id,conversation.id,assistant,"down","too_distant",second.conversationVersion)).toEqual({feedback:{rating:"down",reason:"too_distant"},responsePreferences:["自然承接愿意继续的表达，非必要不提醒暂停或不必展开"]});
    expect(core.getConversationDetail(user.id,conversation.id)).toMatchObject({latestTurn:{userMessageId:second.message.id,assistantMessageId:assistant},replyFeedback:{rating:"down",reason:"too_distant"},responsePreferences:["自然承接愿意继续的表达，非必要不提醒暂停或不必展开"]});
    expect(core.setLatestReplyFeedback(user.id,conversation.id,assistant,"down","too_many_questions",second.conversationVersion)).toMatchObject({responsePreferences:["少追问，一次最多问一个问题"]});
    expect(core.setLatestReplyFeedback(user.id,conversation.id,assistant,null,null,second.conversationVersion)).toEqual({feedback:null,responsePreferences:[]});
    expect(core.clearConversationResponsePreferences(user.id,conversation.id,second.conversationVersion)).toEqual({feedback:null,responsePreferences:[]});
  });

  it("编辑或删除反馈来源时移除其风格贡献，删除会话时清理反馈", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"供反馈使用的合成表达")!;
    const assistant=randomUUID();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`).run(assistant,conversation.id,"合成回复",Date.now()+1);
    const version=core.getConversationById(user.id,conversation.id)!.version;
    core.setLatestReplyFeedback(user.id,conversation.id,assistant,"up","clear",version);
    const edited=core.editUserMessage(user.id,conversation.id,source.message.id,"修订后的合成表达",version);
    expect(edited).not.toHaveProperty("error");
    expect(core.listResponsePreferences(user.id,conversation.id)).toEqual([]);
    const current=core.getConversationDetail(user.id,conversation.id)!;
    const nextAssistant=randomUUID();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?, 'assistant', ?,1,'current',?)`).run(nextAssistant,conversation.id,"另一合成回复",Date.now()+2);
    core.setLatestReplyFeedback(user.id,conversation.id,nextAssistant,"down","mechanical",current.conversation.version);
    expect(core.listResponsePreferences(user.id,conversation.id)).toEqual(["表达自然，避免机械感"]);
    expect(core.deleteConversation(user.id,conversation.id)).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) count FROM private_reply_feedback WHERE conversation_id=?`).get(conversation.id) as {count:number}).count).toBe(0);
  });

  it("有效 current/corrected 笔记可纠正且刷新后保留本人纠正", () => {
    const user=actor(),conversation=core.createConversation(user.id),source=core.addUserMessage(user.id,conversation.id,"我偏好先安静一会儿")!;
    const noteId=addNote(conversation.id,source.message.id);
    const corrected=core.correctNote(user.id,conversation.id,noteId,"本人纠正：我通常先需要一点安静",1);
    expect(corrected).not.toHaveProperty("error");
    if("error" in corrected)throw new Error("有效笔记未能纠正");
    const correctedAgain=core.correctNote(user.id,conversation.id,noteId,"本人再次确认：先安静一会儿",corrected.note.version);
    expect(correctedAgain).not.toHaveProperty("error");
    expect(core.listCurrentNotes(conversation.id)).toEqual(expect.arrayContaining([expect.objectContaining({id:noteId,status:"corrected",correction:"本人再次确认：先安静一会儿"})]));
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const refresh=core.createNotesJob(user.id,conversation.id)!;
    expect(core.claimPrivateJob()?.id).toBe(refresh.id);
    expect(core.completePrivateJob(refresh.id,[{kind:"user_statement",content:"新的合成笔记",sourceMessageIds:[source.message.id]}])).toBe(true);
    expect(core.listCurrentNotes(conversation.id)).toEqual(expect.arrayContaining([expect.objectContaining({id:noteId,status:"corrected",correction:"本人再次确认：先安静一会儿"})]));
  });

  it("B 的旧摘要确认接口同样受会话风险门禁保护", () => {
    const user=actor(),event=createEvent("合成双人事件");
    db.prepare(`UPDATE events SET b_user_id=?,state='b_guiding' WHERE id=?`).run(user.id,event.id);
    const conversation=core.getOrCreateEventConversation(user.id,event.id,"b")!;
    core.addUserMessage(user.id,conversation.id,"他现在威胁我，不让我离开。")!;
    expect(core.confirmEventSummary(user.id,conversation.id,"已编辑的合成摘要",core.getConversationById(user.id,conversation.id)!.version)).toBe("active_risk");
  });

  it("B 确认的纯文本摘要带有合并桥接标记并保留原文", () => {
    const user=actor(),event=createEvent("纯文本摘要桥接");
    db.prepare(`UPDATE events SET b_user_id=?,state='b_guiding' WHERE id=?`).run(user.id,event.id);
    const conversation=core.getOrCreateEventConversation(user.id,event.id,"b")!;
    const confirmed="我很失望，希望下次有变动时能提前告诉我。";
    expect(core.confirmEventSummary(user.id,conversation.id,confirmed,core.getConversationById(user.id,conversation.id)!.version)).toBe("ok");
    const summary=JSON.parse((db.prepare(`SELECT summary FROM perspectives WHERE event_id=? AND role='b'`).get(event.id) as {summary:string}).summary);
    expect(summary).toEqual({format:"confirmed_plain_text",observation:confirmed,feelings:[],needs:[],request:""});
  });

  it("组合式限制离开表达会持久化风险并阻断分享，非本人影视情节不触发", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    const source=core.addUserMessage(user.id,conversation.id,"他现在在门外堵着，不肯让我离开，还拿走了我的手机。我现在用电脑跟你说话。")!;
    expect(core.getConversationDetail(user.id,conversation.id)?.conversation.safetyStatus).toBe("active");
    expect(core.conversationHasActiveRisk(user.id,conversation.id)).toBe(true);
    expect(core.createShareDraftJob(user.id,conversation.id,[source.message.id])).toBe(false);
    core.addUserMessage(user.id,conversation.id,"他说我要是敢叫人来，就让我后悔。我不确定他会做什么。");
    expect(core.getConversationDetail(user.id,conversation.id)?.conversation.safetyStatus).toBe("active");
    const other=core.createConversation(user.id);
    core.addUserMessage(user.id,other.id,"电视剧里角色被堵在门外，不让女主离开；这不是我的经历，也与我无关。");
    expect(core.getConversationDetail(user.id,other.id)?.conversation.safetyStatus).toBe("clear");
  });

  it("只有在风险来源之后已有回复时，后续安全请求才进入进展式回应", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const sent=core.addUserMessage(user.id,conversation.id,"我担心自己会伤害自己。")!;
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(false);
    expect(core.claimPrivateJob()?.id).toBe(sent.jobId);
    expect(core.completePrivateJob(sent.jobId!,{reply:"请联系一位可信任的人陪着你。",safetyResponse:true})).toBe(true);
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(true);
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
  });

  it("连续同类风险段按首条来源认安全回应，保留最新来源；解除后重现视为新段", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const first=core.addUserMessage(user.id,conversation.id,"他堵在门外，不让我离开。")!;
    expect(core.getActiveRiskMessages(user.id,conversation.id).map(item=>item.id)).toEqual([first.message.id]);
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(false);
    const ordinaryId=randomUUID();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES(?,?,'assistant','普通的历史回应',1,'current',?)`).run(ordinaryId,conversation.id,Date.now());
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(false);
    const safetyId=randomUUID();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at,is_safety_response) VALUES(?,?,'assistant','首次安全提醒',1,'current',?,1)`).run(safetyId,conversation.id,Date.now());
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(true);

    const repeated=core.addUserMessage(user.id,conversation.id,"他又说如果我叫朋友来，就让我后悔。")!;
    expect(core.getActiveRiskMessages(user.id,conversation.id).map(item=>item.id)).toEqual([first.message.id,repeated.message.id]);
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(true);
    core.addUserMessage(user.id,conversation.id,"我现在安全，已经离开住处，有朋友陪着我。");
    expect(core.conversationHasActiveRisk(user.id,conversation.id)).toBe(false);
    const newRisk=core.addUserMessage(user.id,conversation.id,"他又堵在门口不让我出去。")!;
    expect(core.getActiveRiskMessages(user.id,conversation.id).map(item=>item.id)).toEqual([newRisk.message.id]);
    expect(core.hasSafetyReplyAfterActiveRisk(user.id,conversation.id)).toBe(false);
  });

  it("详情提供最近失败工作的恢复数据与安全状态", () => {
    const user = actor();
    const conversation = core.createConversation(user.id);
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE status IN ('queued','processing')`).run();
    const sent = core.addUserMessage(user.id, conversation.id, "合成表达")!;
    expect(core.claimPrivateJob()?.id).toBe(sent.jobId);
    core.failPrivateJob(sent.jobId!, "AI_UNAVAILABLE");
    const detail = core.getConversationDetail(user.id, conversation.id)!;
    expect(detail.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reply", status: "failed", errorCode: "AI_UNAVAILABLE", sourceMessageId: sent.message.id })]));
    expect(detail.conversation).toMatchObject({ safetyStatus: "clear" });
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=?`).run(conversation.id);
  });

  it("删除会话会物理删除关联的可归因模型统计", () => {
    const user=actor(),conversation=core.createConversation(user.id);
    core.setAnalyticsPreference(user.id,true);
    recordAiCallMetric({
      call_kind:"private_reply",provider:"synthetic",requested_model:"synthetic",resolved_model:null,
      thinking:false,attempt:1,status:"success",error_type:null,latency_ms:1,prompt_tokens:null,
      completion_tokens:null,reasoning_tokens:null,cached_tokens:null,total_tokens:null,
      estimated_cost_usd_micros:null,pricing_version:null,analytics_user_id:user.id,
      analytics_conversation_id:conversation.id,analytics_event_id:null,
    });
    expect((db.prepare(`SELECT COUNT(*) n FROM ai_call_metrics WHERE analytics_conversation_id=?`).get(conversation.id) as {n:number}).n).toBe(1);
    expect(core.deleteConversation(user.id,conversation.id)).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) n FROM ai_call_metrics WHERE analytics_conversation_id=?`).get(conversation.id) as {n:number}).n).toBe(0);
  });

  it("模型统计兼容旧与新超时分类，并排除普通失败", () => {
    for (let index = 0; index < 5; index++) {
      const user=actor(),conversation=core.createConversation(user.id);
      core.setAnalyticsPreference(user.id,true);
      for (const errorType of ["timeout","request_timeout","response_body_timeout","provider_error"] as const) {
        recordAiCallMetric({
          call_kind:"private_reply",provider:"synthetic",requested_model:"synthetic-timeout-count",resolved_model:null,
          thinking:false,attempt:1,status:"failed",error_type:errorType,latency_ms:1,prompt_tokens:null,
          completion_tokens:null,reasoning_tokens:null,cached_tokens:null,total_tokens:null,
          estimated_cost_usd_micros:null,pricing_version:null,analytics_user_id:user.id,
          analytics_conversation_id:conversation.id,analytics_event_id:null,
        });
      }
    }
    expect(core.getAnalyticsDashboard(7).models).toEqual([
      expect.objectContaining({model:"synthetic-timeout-count",jobKind:"private_reply",calls:20,failed:20,timeouts:15}),
    ]);
  });

  it("共同调用指标要求双方看过说明并同意，任一方关闭或删除事件都会物理删除", () => {
    const a=actor(),b=actor(),event=createEvent("合成共同事件",a.id);
    db.prepare(`UPDATE events SET b_user_id=? WHERE id=?`).run(b.id,event.id);
    const metric={call_kind:"merge" as const,provider:"synthetic",requested_model:"synthetic",resolved_model:null,thinking:false,attempt:1,status:"success" as const,error_type:null,latency_ms:1,prompt_tokens:null,completion_tokens:null,reasoning_tokens:null,cached_tokens:null,total_tokens:null,estimated_cost_usd_micros:null,pricing_version:null,analytics_user_id:null,analytics_conversation_id:null,analytics_event_id:event.id};
    expect(()=>recordAiCallMetric(metric)).toThrow(/both event participants/);
    core.setAnalyticsPreference(a.id,true);core.setAnalyticsPreference(b.id,true);
    recordAiCallMetric(metric);
    expect((db.prepare(`SELECT COUNT(*) n FROM ai_call_metrics WHERE analytics_event_id=?`).get(event.id) as {n:number}).n).toBe(1);
    core.setAnalyticsPreference(b.id,false);
    expect((db.prepare(`SELECT COUNT(*) n FROM ai_call_metrics WHERE analytics_event_id=?`).get(event.id) as {n:number}).n).toBe(0);
    core.setAnalyticsPreference(b.id,true);recordAiCallMetric(metric);
    expect(deleteEventCompletely(event.id)).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) n FROM ai_call_metrics WHERE analytics_event_id=?`).get(event.id) as {n:number}).n).toBe(0);
  });
});
