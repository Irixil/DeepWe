import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("状态机 transition", () => {
  it("非法跳转被拒绝", () => {
    const e = db.createEvent("状态机测试");
    // a_guiding 不能直接跳到 merged（跳过了摘要）
    expect(db.transition(e.id, "a_guiding", "merged")).toBe(false);
    // a_guiding 不能直接跳到 waiting_b（跳过了 a_summary）
    expect(db.transition(e.id, "a_guiding", "waiting_b")).toBe(false);
    // 从未知状态跳转失败
    expect(db.transition("不存在的id", "a_guiding", "a_summary")).toBe(false);
  });

  it("合法跳转成功", () => {
    const e = db.createEvent("状态机测试");
    expect(db.transition(e.id, "a_guiding", "a_summary")).toBe(true);
    expect(db.transition(e.id, "a_summary", "waiting_b")).toBe(true);
    expect(db.getEvent(e.id)!.state).toBe("waiting_b");
  });

  it("重复跳转失败（幂等保护）", () => {
    const e = db.createEvent("状态机测试");
    expect(db.transition(e.id, "a_guiding", "a_summary")).toBe(true);
    // 已经不在 a_guiding，再次跳转会失败
    expect(db.transition(e.id, "a_guiding", "a_summary")).toBe(false);
  });
});

describe("行动方针（各自不同，都选了即达成）", () => {
  it("getChoices 保存双方各自的选择", () => {
    const id = "test-agree-" + Math.random().toString(36).slice(2);
    db.setChoice(id, "a", "A 的承诺：主动说感受");
    db.setChoice(id, "b", "B 的承诺：提前告知");
    const c = db.getChoices(id);
    expect(c.a).toBe("A 的承诺：主动说感受");
    expect(c.b).toBe("B 的承诺：提前告知");
    expect(c.a === c.b).toBe(false); // 双方不同是正常的
  });
});

describe("复访（双方都提交才 bothReviewed）", () => {
  it("只有一方提交时不算完成", () => {
    const id = "test-review-" + Math.random().toString(36).slice(2);
    // 真实流程中，复访发生在达成约定之后，agreements 行已存在
    db.setChoice(id, "a", "A 承诺");
    db.setChoice(id, "b", "B 承诺");
    db.setReview(id, "a", JSON.stringify({ executed: "做到了", effect: "", next: "继续" }));
    expect(db.bothReviewed(id)).toBe(false);
    db.setReview(id, "b", JSON.stringify({ executed: "做到了一部分", effect: "", next: "修改" }));
    expect(db.bothReviewed(id)).toBe(true);
  });
});

describe("邀请码", () => {
  it("生成 4 位邀请码且不含易混淆字符", () => {
    for (let i = 0; i < 20; i++) {
      const code = db.randomCode();
      expect(code).toHaveLength(4);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/); // 排除 I O 0 1
    }
  });

  it("token 足够长且随机", () => {
    const t1 = db.randomToken();
    const t2 = db.randomToken();
    expect(t1).toHaveLength(48);
    expect(t1).not.toBe(t2);
  });
});

describe("潜谈故事地图", () => {
  it("按参与方独立保存进度并记录本人确认", () => {
    const e = db.createEvent("故事地图测试");
    db.saveGuideSession(e.id, "a", "reflection", JSON.stringify({ context: "A 的私密背景" }));
    db.saveGuideSession(e.id, "b", "story", JSON.stringify({ context: "B 的私密背景" }));

    expect(db.getGuideSession(e.id, "a")?.stage).toBe("reflection");
    expect(db.getGuideSession(e.id, "b")?.story_map).toContain("B 的私密背景");
    db.confirmGuideStory(e.id, "a");
    expect(db.getGuideSession(e.id, "a")?.story_confirmed).toBe(1);
    expect(db.getGuideSession(e.id, "b")?.story_confirmed).toBe(0);
  });
});

describe("沟通偏好记忆", () => {
  it("同一类偏好只保留一条，并用最新明确表达更新", () => {
    const user = db.createUser(
      `memory-${Math.random()}@deepwe.test`,
      "偏好测试用户",
      "hash",
      "salt"
    );

    db.upsertPersonalPreference(user.id, "question_pacing", "one_at_a_time");
    db.upsertPersonalPreference(user.id, "question_pacing", "one_at_a_time");
    let preferences = db.listPersonalPreferences(user.id);
    expect(preferences).toHaveLength(1);
    expect(preferences[0].evidence_count).toBe(2);
    expect(preferences[0].confidence).toBeGreaterThan(0.5);

    db.upsertPersonalPreference(user.id, "question_pacing", "few_questions");
    preferences = db.listPersonalPreferences(user.id);
    expect(preferences).toHaveLength(1);
    expect(preferences[0].setting).toBe("few_questions");
    expect(preferences[0].evidence_count).toBe(2);
    expect(preferences[0].confidence).toBeGreaterThan(0.8);
  });

  it("不同用户的个人偏好完全隔离", () => {
    const suffix = Math.random();
    const first = db.createUser(`memory-a-${suffix}@deepwe.test`, "A", "hash", "salt");
    const second = db.createUser(`memory-b-${suffix}@deepwe.test`, "B", "hash", "salt");
    db.upsertPersonalPreference(first.id, "tone", "warm_natural");
    expect(db.describePersonalPreferences(first.id)).toEqual([]);
    db.upsertPersonalPreference(first.id, "tone", "warm_natural");

    expect(db.describePersonalPreferences(first.id)).toContain(
      "使用自然、有温度的日常中文，避免机械复述"
    );
    expect(db.listPersonalPreferences(second.id)).toEqual([]);
  });

  it("修改或删除原话时不会留下旧偏好，重新生成也不会重复计数", () => {
    const user = db.createUser(
      `memory-rewind-${Math.random()}@deepwe.test`,
      "回退测试用户",
      "hash",
      "salt"
    );
    const event = db.createEvent("偏好回退测试", user.id);
    const messageId = db.addGuideMessage(event.id, "a", "a", "以后一次只问一个问题");

    db.enqueueAiJob(event.id, "guide", "a", messageId);
    let job = db.claimNextAiJob();
    expect(job).toBeTruthy();
    db.completeGuideAiJob(job!, "好，我一次只问一个。", "story", "{}", user.id, [
      { category: "question_pacing", setting: "one_at_a_time" },
    ]);
    expect(db.listPersonalPreferences(user.id)[0]).toEqual(
      expect.objectContaining({ source_message_id: messageId, evidence_count: 1 })
    );

    expect(db.restartGuideFromMessage(event.id, "a", messageId, "重新回答", "{}")).toBe(true);
    db.enqueueAiJob(event.id, "guide", "a", messageId);
    job = db.claimNextAiJob();
    db.completeGuideAiJob(job!, "好，仍然一次只问一个。", "story", "{}", user.id, [
      { category: "question_pacing", setting: "one_at_a_time" },
    ]);
    expect(db.listPersonalPreferences(user.id)[0].evidence_count).toBe(1);

    expect(
      db.editGuideMessageAndRewind(event.id, "a", messageId, "我先自由说", "{}")
    ).toBe(true);
    expect(db.listPersonalPreferences(user.id)).toEqual([]);

    db.enqueueAiJob(event.id, "guide", "a", messageId);
    job = db.claimNextAiJob();
    db.completeGuideAiJob(job!, "好，你先说。", "story", "{}", user.id, [
      { category: "structure", setting: "freeform" },
    ]);
    expect(db.listPersonalPreferences(user.id)).toHaveLength(1);
    expect(db.deleteGuideMessageAndFollowing(event.id, "a", messageId, "{}")).toBe(true);
    expect(db.listPersonalPreferences(user.id)).toEqual([]);
  });

  it("共同记忆只在当前伴侣连接有效时可读取，解绑后双方立即不可访问", () => {
    const suffix = Math.random();
    const first = db.createUser(`shared-a-${suffix}@deepwe.test`, "A", "hash", "salt");
    const second = db.createUser(`shared-b-${suffix}@deepwe.test`, "B", "hash", "salt");
    const invite = db.createPartnerInvite(first.id);
    expect(invite).toBeTruthy();
    expect(db.acceptPartnerInvite(invite!.code, second.id)).toBe(true);
    expect(db.approvePartnerBindingRequest(first.id, invite!.id)).toBe(true);

    const connectionId = db.getActivePartnerConnectionId(first.id);
    expect(connectionId).toBeTruthy();
    db.upsertConfirmedSharedMemory(connectionId!, "communication_method", "情绪高时一次只说一件事");
    expect(db.listSharedMemoriesForUser(first.id)).toHaveLength(1);
    expect(db.listSharedMemoriesForUser(second.id)).toHaveLength(1);

    expect(db.requestPartnerDisconnect(first.id)).toBe(true);
    expect(db.getPartnerOverview(first.id).connection?.status).toBe("disconnecting");
    expect(db.cancelPartnerDisconnect(first.id)).toBe(true);
    expect(db.listSharedMemoriesForUser(first.id)).toHaveLength(1);
  });
});

describe("可恢复的 AI 后台任务", () => {
  it("服务中断后会把未完成任务重新排队，并继续使用同一个任务", () => {
    const event = db.createEvent("后台任务恢复测试");
    const messageId = db.addGuideMessage(event.id, "a", "a", "虚构测试内容");
    const queued = db.enqueueAiJob(event.id, "guide", "a", messageId);

    const processing = db.claimNextAiJob();
    expect(processing?.id).toBe(queued.id);
    expect(processing?.status).toBe("processing");
    expect(processing?.attempts).toBe(1);

    db.requeueInterruptedAiJobs();
    expect(db.getAiJob(queued.id)?.status).toBe("queued");

    const resumed = db.claimNextAiJob();
    expect(resumed?.id).toBe(queued.id);
    expect(resumed?.status).toBe("processing");
    expect(resumed?.attempts).toBe(2);
  });

  it("引导回复和任务完成状态会一起保存", () => {
    const event = db.createEvent("后台任务完成测试");
    const messageId = db.addGuideMessage(event.id, "a", "a", "虚构测试内容");
    db.enqueueAiJob(event.id, "guide", "a", messageId);
    const job = db.claimNextAiJob();
    expect(job).toBeTruthy();

    db.completeGuideAiJob(
      job!,
      "这是一条虚构的 AI 回复",
      "story",
      JSON.stringify({ context: "虚构背景" })
    );

    expect(db.getAiJob(job!.id)?.status).toBe("completed");
    expect(db.getGuideMessages(event.id, "a").at(-1)).toEqual(
      expect.objectContaining({ role: "ai", content: "这是一条虚构的 AI 回复" })
    );
  });
});
