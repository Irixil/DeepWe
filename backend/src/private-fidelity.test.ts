import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AiServiceError, privateConversationReply, refreshPrivateConversationNotes } from "./ai";
import { createUser, db } from "./db";
import * as core from "./private-core";
import { wakePrivateWorker } from "./private-ai-worker";
import { normalizePrivateNotesFidelity } from "./source-fidelity";

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
function auditResponse(content: string, kind: "narration" | "owner_to_partner" = "narration"): Response {
  return response(JSON.stringify({ segments: [{ kind, text: content }] }));
}
function replyOrAuditResponse(content: string, init?: RequestInit, kind: "narration" | "owner_to_partner" = "narration"): Response {
  const body = JSON.parse(String(init?.body)) as { response_format?: { type: string } };
  return body.response_format?.type === "json_object" ? auditResponse(content, kind) : response(content);
}
beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-offline-test-key");
  vi.stubEnv("DEEPWE_PRIVATE_PROVIDER", "deepseek");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("私密来源核对的 AI 与真实 worker 路径（合成 DB，mock transport）", () => {
  it("主答与核对提示均约束等待前提；无依据时间附加语本地移除不加请求", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return replyOrAuditResponse("你在等待时的感受，对方是否知道？", init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await privateConversationReply({ history: [], message: "伴侣晚到，我感到失落。原因还不知道。", notes: [], personalPreferences: [] });
    expect(result.reply).toBe("你当时的感受，对方是否知道？");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0]!.messages[0]!.content).toContain("事件延误或没有回应不自动证明本人一直等待");
    expect(requests[1]!.messages[0]!.content).toContain("晚到、未回复并不证明本人在等待");
  });

  it("核对器仍返回不可拆肯定等待时失败，不退回首答、不增加请求", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(response("合成首答"))
      .mockResolvedValueOnce(auditResponse("你一直在等他。"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(privateConversationReply({ history: [], message: "伴侣晚到，我感到失落。", notes: [], personalPreferences: [] }))
      .rejects.toBeInstanceOf(AiServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith("Private reply blocked by local source check", { reason: expect.any(String) });
  });

  it("核对器返回旧纯文本格式时拒绝，不回退首答或增加请求", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(response("合成首答"))
      .mockResolvedValueOnce(response("你可以继续说说。"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(privateConversationReply({ history: [], message: "我想接着聊。", notes: [], personalPreferences: [] }))
      .rejects.toBeInstanceOf(AiServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith("Model response unavailable", expect.objectContaining({ stage: "audit", reason: "invalid_schema" }));
  });

  it("代写只有无来源时间附加语时保持两句与原有内容", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) =>
      replyOrAuditResponse("你晚到，我在等的时候感到失落。我只是想表达我的感受。", init, "owner_to_partner")));
    const result = await privateConversationReply({ history: [], message: "伴侣晚到，我失落。只代写两句，不加承诺。", notes: [], personalPreferences: [] });
    expect(result.reply).toBe("你晚到，我当时感到失落。我只是想表达我的感受。");
  });

  it("有来源的相邻事件与感受只生成显式未确认解释，提示区分两端与因果", async () => {
    let prompt = "";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      prompt = JSON.parse(String(init?.body)).messages[0].content;
      return response(JSON.stringify({ notes: [{ kind: "user_statement", content: "用户因伴侣晚到而感到失落。", sourceMessageIds: ["m1"] }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const notes = await refreshPrivateConversationNotes({ messages: [{ id: "m1", content: "伴侣晚到，我感到失落。", version: 1 }], priorNotes: [], corrections: [] });
    expect(notes[0]).toMatchObject({ kind: "tentative_understanding", content: "尚未由用户确认的可能理解：用户因伴侣晚到而感到失落。" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("事件和感受相邻出现不自动成为本人明确确认的因果");
  });

  it.each([
    { notes: "bad" },
    { notes: [{ kind: "user_statement", content: "有效内容", sourceMessageIds: ["m1"] }, { kind: "user_statement", content: "无效内容", sourceMessageIds: [] }] },
    { notes: [{ kind: "user_statement", content: "错误来源", sourceMessageIds: ["missing"] }] },
    { notes: [{ kind: "user_statement", content: "长".repeat(1001), sourceMessageIds: ["m1"] }] },
  ])("无效完整笔记批次失败且不重试、不伪装合法[] %#", async payload => {
    const fetchMock = vi.fn(async () => response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshPrivateConversationNotes({ messages: [{ id: "m1", content: "合成原话", version: 1 }], priorNotes: [], corrections: [] }))
      .rejects.toBeInstanceOf(AiServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("合法空笔记保持成功空数组", async () => {
    const fetchMock = vi.fn(async () => response('{"notes":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshPrivateConversationNotes({ messages: [], priorNotes: [], corrections: [] })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["edit", "delete"] as const)("单数值纠正笔记依赖两条来源，纠正消息%s后失效", operation => {
    const user=createUser(randomUUID()+"@offline-fidelity.test", "合成依赖用户", "hash", "salt");
    const conversation=core.createConversation(user.id);
    const first=core.addUserMessage(user.id,conversation.id,"我因为连续加班五天而疲惫。")!;
    core.cancelJob(user.id,conversation.id,first.jobId!);
    const second=core.addUserMessage(user.id,conversation.id,"更正一下，连续加班三天，其他事实不变。",randomUUID())!;
    core.cancelJob(user.id,conversation.id,second.jobId!);
    const currentVersion=core.getConversationById(user.id,conversation.id)!.version;
    const refresh=core.createNotesJob(user.id,conversation.id)!;
    expect(core.claimPrivateJob("background")?.id).toBe(refresh.id);
    const notes=normalizePrivateNotesFidelity([{kind:"user_statement",content:"用户因连续加班三天而疲惫。",sourceMessageIds:[first.message.id,second.message.id]}], {
      messages:[first.message,second.message],
    });
    expect(notes[0]!.kind).toBe("user_statement");
    expect(core.completePrivateJob(refresh.id,notes)).toBe(true);
    const saved=core.listCurrentNotes(conversation.id)[0]!;
    expect(saved.sourceMessageIds).toEqual([first.message.id,second.message.id]);
    const provenance=db.prepare("SELECT source_message_versions FROM private_notes WHERE id=?").get(saved.id) as {source_message_versions:string};
    expect(JSON.parse(provenance.source_message_versions)).toEqual({[first.message.id]:1,[second.message.id]:1});
    if(operation==="edit") {
      const edited=core.editUserMessage(user.id,conversation.id,second.message.id,"更正一下，连续加班四天，其他事实不变。",currentVersion);
      expect(edited).not.toHaveProperty("error");
      if("jobId" in edited) core.cancelJob(user.id,conversation.id,edited.jobId!);
    } else {
      expect(core.deleteUserMessage(user.id,conversation.id,second.message.id,currentVersion)).toBe("ok");
    }
    expect(core.listCurrentNotes(conversation.id).some(note=>note.id===saved.id)).toBe(false);
  });

  it("真实 worker 中笔记校验失败保留已合格回复和原有效笔记，并可单独重试", async () => {
    const user = createUser(randomUUID()+"@offline-fidelity.test", "合成来源核对用户", "hash", "salt");
    const conversation = core.createConversation(user.id);
    const source = core.addUserMessage(user.id, conversation.id, "伴侣晚到，我感到失落。")!;
    const noteId = randomUUID();
    db.prepare(`INSERT INTO private_notes(id,conversation_id,kind,content,source_message_ids,source_message_versions,source_conversation_version,version,status,updated_at)
      VALUES(?,?,'user_statement',?,?,?, ?,1,'current',?)`).run(noteId, conversation.id, "用户表达失落。", JSON.stringify([source.message.id]), JSON.stringify({ [source.message.id]: source.message.version }), source.conversationVersion, Date.now());
    const oldNote = core.listCurrentNotes(conversation.id).find(note => note.id === noteId)!;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests++;
      return requests <= 2 ? replyOrAuditResponse("你在等待时的感受，对方是否知道？", init)
        : response('{"notes":[{"kind":"user_statement","content":"合成不可落库正文","sourceMessageIds":["missing"]}]}');
    }));
    wakePrivateWorker();
    await vi.waitFor(() => expect(core.getJobForSource(user.id, conversation.id, source.message.id)?.status).toBe("completed"), { timeout: 3000 });
    await vi.waitFor(() => expect(db.prepare("SELECT status FROM private_jobs WHERE conversation_id=? AND kind='notes'").get(conversation.id)).toMatchObject({ status: "failed" }), { timeout: 3000 });
    expect(requests).toBe(3);
    expect(core.listCurrentMessages(conversation.id).filter(message => message.role === "assistant").map(message => message.content)).toEqual(["你当时的感受，对方是否知道？"]);
    expect(core.listCurrentNotes(conversation.id).find(note => note.id === noteId)).toEqual(oldNote);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("合成不可落库正文");
    const failed = db.prepare("SELECT id FROM private_jobs WHERE conversation_id=? AND kind='notes'").get(conversation.id) as { id: string };
    vi.stubGlobal("fetch", vi.fn(async () => { requests++; return response(JSON.stringify({ notes: [{ kind: "user_statement", content: "用户表达失落。", sourceMessageIds: [source.message.id] }] })); }));
    const retry=core.retryJob(user.id, conversation.id, failed.id)!;
    expect(retry.status).toBe("queued");
    wakePrivateWorker();
    await vi.waitFor(() => expect(core.getPrivateJob(user.id, conversation.id, retry.id)?.status).toBe("completed"), { timeout: 3000 });
    expect(requests).toBe(4);
    expect(core.listCurrentMessages(conversation.id).filter(message => message.role === "assistant")).toHaveLength(1);
    expect(core.listCurrentNotes(conversation.id).some(note => note.content === "用户表达失落。")).toBe(true);
  });
});

