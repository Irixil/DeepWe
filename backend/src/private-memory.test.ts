import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createUser, db } from "./db";
import * as core from "./private-core";
import { getPrivateMemory, getPrivateMemoryReplySnapshot, updatePrivateMemorySettings } from "./private-memory";

describe("same-conversation natural memory corrections", () => {
  it("joins derived background clauses without duplicate separators or a trailing comma", () => {
    const user = createUser(`${randomUUID()}@private-memory.test`, "合成标点用户", "hash", "salt", false);
    const conversation = core.createConversation(user.id);
    const source = core.addUserMessage(user.id, conversation.id,
      "周五傍晚我们约好在家一起烘焙面包。伴侣小林晚到二十分钟，我感到失落。我还没问清为什么。");
    if (!source) throw new Error("source conversation unavailable");
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','processing')`).run(conversation.id);
    const notesJob = core.createNotesJob(user.id, conversation.id);
    if (!notesJob) throw new Error("notes job unavailable");
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=?`).run(notesJob.id);
    expect(core.completePrivateJob(notesJob.id, [{ kind: "user_statement",
      content: "用户当时原话是“周五傍晚我们约好在家一起烘焙面包”；用户与伴侣小林有这项约定，伴侣小林晚到二十分钟。",
      sourceMessageIds: [source.message.id] }])).toBe(true);
    expect(updatePrivateMemorySettings(user.id, true, 1)).not.toHaveProperty("error");
    const correction = core.addUserMessage(user.id, conversation.id,
      "我之前关于烘焙安排的迟到时间说错了，不是二十分钟，是十分钟。");
    if (!correction) throw new Error("correction unavailable");
    const row = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=?
      AND source_note_id LIKE 'natural-correction-context:%' AND status='current'`).get(user.id) as {
        content: string; source_message_ids: string; source_message_versions: string; correction_metadata: string };
    expect(row.content).toBe("用户当时原话是“周五傍晚我们约好在家一起烘焙面包”；用户与伴侣小林有这项约定");
    expect(JSON.parse(row.source_message_ids)).toEqual([source.message.id]);
    expect(JSON.parse(row.source_message_versions)).toEqual({ [source.message.id]: 1 });
    expect(JSON.parse(row.correction_metadata)).toMatchObject({
      type: "natural_correction_context", appliedByMessageId: correction.message.id, appliedByMessageVersion: 1 });
    expect(core.listCurrentMessages(conversation.id).find(item => item.id === source.message.id)?.content)
      .toBe("周五傍晚我们约好在家一起烘焙面包。伴侣小林晚到二十分钟，我感到失落。我还没问清为什么。");
  });

  it.each([
    ["周五在家烘焙；；小林有约定，", "周五在家烘焙；小林有约定"],
    ["周五在家烘焙。；小林有约定！；", "周五在家烘焙。小林有约定！"],
    ["原因未知？；用户失落，；", "原因未知？用户失落"],
    ["； ; 周五在家烘焙，；； 小林有约定,", "周五在家烘焙；小林有约定"],
    ["原话是“烘焙；；可以吗？”；；小林有约定，", "原话是“烘焙；；可以吗？”；小林有约定"],
    ['原话是"烘焙;;可以吗？"；；小林有约定，', '原话是"烘焙;;可以吗？"；小林有约定'],
    ["原话是“她说“烘焙”；；我有疑问，”；；小林有约定，", "原话是“她说“烘焙”；；我有疑问，”；小林有约定"],
    ['原话是"她说\\"烘焙\\";;我有疑问,"；；小林有约定，', '原话是"她说\\"烘焙\\";;我有疑问,"；小林有约定'],
    ["原话是“烘焙；；小林有约定，", "原话是“烘焙；；小林有约定，"],
    ["原话是‘烘焙；；可以吗？’；；小林有约定，", "原话是‘烘焙；；可以吗？’；小林有约定"],
    ["原话是'烘焙;;可以吗？'；；小林有约定，", "原话是'烘焙;;可以吗？'；小林有约定"],
    ["原话是‘烘焙；；小林有约定，", "原话是‘烘焙；；小林有约定，"],
  ])("formats only derived memory reads while preserving raw rows: %s", (raw, expected) => {
    const user = createUser(`${randomUUID()}@private-memory.test`, "合成历史标点用户", "hash", "salt", false);
    const conversation = core.createConversation(user.id);
    const source = core.addUserMessage(user.id, conversation.id, "周五在家烘焙，小林有约定。原因未知，用户失落。");
    if (!source) throw new Error("source unavailable");
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','processing')`).run(conversation.id);
    const job = core.createNotesJob(user.id, conversation.id);
    if (!job) throw new Error("notes job unavailable");
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=?`).run(job.id);
    expect(core.completePrivateJob(job.id, [{ kind: "user_statement", content: "周五在家烘焙，小林有约定。", sourceMessageIds: [source.message.id] }])).toBe(true);
    expect(updatePrivateMemorySettings(user.id, true, 1)).not.toHaveProperty("error");
    const item = getPrivateMemory(user.id).items[0];
    db.prepare(`UPDATE private_memory_items SET content=?,correction_metadata=? WHERE id=?`)
      .run(raw, JSON.stringify({ type: "natural_correction_context" }), item.id);
    const before = db.prepare(`SELECT * FROM private_memory_items WHERE id=?`).get(item.id);
    const view = getPrivateMemory(user.id).items.find(row => row.id === item.id)!;
    expect(view).toMatchObject({ ...item, content: expected });
    expect(raw.replace(/[，,；;\s]/gu, "")).toBe(expected.replace(/[，,；;\s]/gu, ""));
    expect(db.prepare(`SELECT * FROM private_memory_items WHERE id=?`).get(item.id)).toEqual(before);
    db.prepare(`UPDATE private_memory_items SET correction_metadata=NULL WHERE id=?`).run(item.id);
    expect(getPrivateMemory(user.id).items.find(row => row.id === item.id)?.content).toBe(raw);
  });

  it("keeps nonnumeric context while excluding other numeric clauses from a derived correction context", () => {
    const user = createUser(`${randomUUID()}@private-memory.test`, "合成数字残余用户", "hash", "salt", false);
    const conversation = core.createConversation(user.id);
    const source = core.addUserMessage(user.id, conversation.id,
      "周五傍晚我们约好在家一起烘焙面包。伴侣小林晚到二十分钟，我感到失落。另外我等了三分钟。我还没问清为什么。");
    if (!source) throw new Error("source conversation unavailable");
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','processing')`).run(conversation.id);
    const notesJob = core.createNotesJob(user.id, conversation.id);
    if (!notesJob) throw new Error("notes job unavailable");
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=? AND status='queued'`).run(notesJob.id);
    expect(core.completePrivateJob(notesJob.id, [{
      kind: "user_statement",
      content: "烘焙安排伴侣小林晚到二十分钟，用户感到失落。另外等待三分钟。",
      sourceMessageIds: [source.message.id],
    }])).toBe(true);
    expect(updatePrivateMemorySettings(user.id, true, 1)).not.toHaveProperty("error");

    const correction = core.addUserMessage(user.id, conversation.id,
      "我之前关于烘焙安排的迟到时间说错了，不是二十分钟，是十分钟。");
    if (!correction) throw new Error("correction message unavailable");

    const derivedRows = db.prepare(`SELECT content FROM private_memory_items
      WHERE owner_user_id=? AND source_note_id LIKE 'natural-correction-context:%' AND status='current'`)
      .all(user.id) as { content: string }[];
    expect(derivedRows.map(row => row.content)).toEqual(["用户感到失落。"]);
    expect(derivedRows.some(row => /三分钟|二十分钟/u.test(row.content))).toBe(false);
  });

  it("applies a unique 20-to-10-minute lateness correction and preserves event context and unknowns", () => {
    const user = createUser(`${randomUUID()}@private-memory.test`, "合成记忆用户", "hash", "salt", false);
    const conversation = core.createConversation(user.id);
    const source = core.addUserMessage(user.id, conversation.id,
      "周五傍晚我们约好在家一起烘焙面包。伴侣小林晚到二十分钟，我感到失落。我还没问清为什么。");
    if (!source) throw new Error("source conversation unavailable");
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','processing')`).run(conversation.id);

    const notesJob = core.createNotesJob(user.id, conversation.id);
    if (!notesJob) throw new Error("notes job unavailable");
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=? AND status='queued'`).run(notesJob.id);
    expect(core.completePrivateJob(notesJob.id, [
      { kind: "user_statement", content: "周五傍晚用户与伴侣小林在家一起烘焙面包。", sourceMessageIds: [source.message.id] },
      { kind: "user_statement", content: "烘焙安排伴侣小林晚到二十分钟，用户感到失落。", sourceMessageIds: [source.message.id] },
      { kind: "unknown", content: "烘焙安排中伴侣小林晚到的原因尚未确认。", sourceMessageIds: [source.message.id] },
    ])).toBe(true);
    expect(updatePrivateMemorySettings(user.id, true, 1)).not.toHaveProperty("error");
    const originalCompound = getPrivateMemory(user.id).items.find(item =>
      item.content === "烘焙安排伴侣小林晚到二十分钟，用户感到失落。");
    if (!originalCompound) throw new Error("compound memory unavailable before correction");

    const correction = core.addUserMessage(user.id, conversation.id,
      "我之前关于烘焙安排的迟到时间说错了，不是二十分钟，是十分钟。");
    if (!correction) throw new Error("correction message unavailable");

    const memory = getPrivateMemory(user.id);
    expect(memory.pendingCorrections).toEqual([]);
    expect(memory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user_statement", content: "周五傍晚用户与伴侣小林在家一起烘焙面包。" }),
      expect.objectContaining({ kind: "user_statement", content: "用户感到失落。" }),
      expect.objectContaining({ kind: "unknown", content: "烘焙安排中伴侣小林晚到的原因尚未确认。" }),
      expect.objectContaining({ correctionStatus: "applied", content: "我之前关于烘焙安排的迟到时间说错了，不是二十分钟，是十分钟。" }),
    ]));
    expect(memory.items.filter(item => item.content.includes("二十分钟")))
      .toEqual([expect.objectContaining({ correctionStatus: "applied" })]);
    expect(memory.items.some(item => item.content === "烘焙安排伴侣小林晚到二十分钟，用户感到失落。")).toBe(false);

    const derivedContext = db.prepare(`SELECT content,source_conversation_id,source_message_ids,source_message_versions,correction_metadata
      FROM private_memory_items WHERE owner_user_id=? AND source_note_id LIKE 'natural-correction-context:%' AND status='current'`)
      .get(user.id) as { content:string; source_conversation_id:string; source_message_ids:string; source_message_versions:string; correction_metadata:string } | undefined;
    expect(derivedContext?.content).toBe("用户感到失落。");
    expect(derivedContext?.source_conversation_id).toBe(conversation.id);
    expect(JSON.parse(derivedContext?.source_message_ids ?? "[]")).toEqual([source.message.id]);
    expect(JSON.parse(derivedContext?.source_message_versions ?? "{}")).toEqual({ [source.message.id]: 1 });
    expect(JSON.parse(derivedContext?.correction_metadata ?? "{}")).toMatchObject({
      type: "natural_correction_context",
      appliedByMessageId: correction.message.id,
      fromMemoryId: originalCompound.id,
      fromMemoryVersion: originalCompound.version,
      supersedes: [expect.objectContaining({
        memoryItemId: originalCompound.id,
        sourceConversationId: conversation.id,
        sourceMessageIds: [source.message.id],
        sourceMessageVersions: { [source.message.id]: 1 },
      })],
    });

    // Reprocessing the pre-correction compound note must not restore its old duration.
    const repeatedNotesJob = core.createNotesJob(user.id, conversation.id);
    if (!repeatedNotesJob) throw new Error("repeat notes job unavailable");
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=? AND status='queued'`).run(repeatedNotesJob.id);
    expect(core.completePrivateJob(repeatedNotesJob.id, [{
      kind: "user_statement", content: "烘焙安排伴侣小林晚到二十分钟，用户感到失落。", sourceMessageIds: [source.message.id],
    }])).toBe(true);
    const afterRepeat = getPrivateMemory(user.id);
    expect(afterRepeat.items.some(item => item.content === "烘焙安排伴侣小林晚到二十分钟，用户感到失落。")).toBe(false);
    expect(afterRepeat.items.some(item => item.content === "用户感到失落。")).toBe(true);
    expect(afterRepeat.items.filter(item => item.content.includes("二十分钟")))
      .toEqual([expect.objectContaining({ correctionStatus: "applied" })]);

    // Fill the ordinary top-five ranking with newer, lexically similar notes
    // from other events. Only the exact corrected source cluster gets priority.
    for (let index = 1; index <= 6; index++) {
      const otherConversation = core.createConversation(user.id);
      const otherSource = core.addUserMessage(user.id, otherConversation.id,
        `另一次烘焙安排：我们在朋友家做饼干，伴侣小林晚到，我感到失落。SYNTHETIC_OTHER_BAKING_${index}`);
      if (!otherSource) throw new Error("competing source conversation unavailable");
      db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','processing')`).run(otherConversation.id);
      const otherNotesJob = core.createNotesJob(user.id, otherConversation.id);
      if (!otherNotesJob) throw new Error("competing notes job unavailable");
      db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=? AND status='queued'`).run(otherNotesJob.id);
      expect(core.completePrivateJob(otherNotesJob.id, [{
        kind: "user_statement",
        content: `另一次烘焙安排：在朋友家做饼干，伴侣小林晚到，我感到失落。SYNTHETIC_OTHER_BAKING_${index}`,
        sourceMessageIds: [otherSource.message.id],
      }])).toBe(true);
    }
    const recallConversation = core.createConversation(user.id);
    const recall = getPrivateMemoryReplySnapshot(user.id,
      "继续说那次烘焙安排。原来是什么时候、在哪儿、谁晚到、现在记的是多久、我原来有什么感受？原因还不清楚，请别替我猜。",
      recallConversation.id);
    expect(recall.items).toHaveLength(5);
    expect(recall.items.slice(0, 3).map(item => item.content)).toEqual(expect.arrayContaining([
      "周五傍晚用户与伴侣小林在家一起烘焙面包。",
      "用户感到失落。",
      "烘焙安排中伴侣小林晚到的原因尚未确认。",
    ]));
    expect(recall.items.slice(0, 3).some(item => item.content.includes("SYNTHETIC_OTHER_BAKING_"))).toBe(false);
    expect(recall.knownCorrections).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "烘焙", oldMinutes: 20, newMinutes: 10 }),
    ]));
    expect(recall.items.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(1800);

    const dinnerConversation = core.createConversation(user.id);
    const dinnerSource = core.addUserMessage(user.id, dinnerConversation.id,
      "周三晚上我和家人约好吃晚饭，姐姐晚到五分钟。原因还不知道。");
    if (!dinnerSource) throw new Error("unrelated source conversation unavailable");
    db.prepare(`UPDATE private_jobs SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','processing')`).run(dinnerConversation.id);
    const dinnerJob = core.createNotesJob(user.id, dinnerConversation.id);
    if (!dinnerJob) throw new Error("unrelated notes job unavailable");
    db.prepare(`UPDATE private_jobs SET status='processing' WHERE id=? AND status='queued'`).run(dinnerJob.id);
    expect(core.completePrivateJob(dinnerJob.id, [{
      kind: "user_statement", content: "周三晚上用户与家人约好吃晚饭，姐姐晚到五分钟。", sourceMessageIds: [dinnerSource.message.id],
    }])).toBe(true);
    const dinnerQueryConversation = core.createConversation(user.id);
    const dinnerRecall = getPrivateMemoryReplySnapshot(user.id, "继续说晚饭安排，姐姐晚到多久？",
      dinnerQueryConversation.id);
    expect(dinnerRecall.knownCorrections).toEqual([]);
    expect(dinnerRecall.items.some(item => item.content === "周五傍晚用户与伴侣小林在家一起烘焙面包。")).toBe(false);
  });
});
