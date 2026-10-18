import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyStoryMap } from "./ai";
import {
  DIALOGUE_POLICIES,
  checkDialoguePolicyBoundaries,
  formatDialoguePolicies,
  hasAffirmedBoundaryMatch,
  selectDialoguePolicies,
} from "./professional";

describe("DeepWe 对话策略选择", () => {
  it("策略库覆盖主要对话领域且不依赖外部语料运行", () => {
    expect(DIALOGUE_POLICIES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(DIALOGUE_POLICIES.map((card) => card.domain))).toEqual(
      new Set(["story", "emotion", "meaning", "conflict", "repair", "boundary", "safety"])
    );
  });

  it("承诺落空时检索信任与期待相关方法", () => {
    const cards = selectDialoguePolicies(
      "reflection",
      "他明明答应周末陪我，后来又忘了，我觉得自己一点都不被重视",
      emptyStoryMap()
    );
    expect(cards.map((card) => card.id)).toContain("conflict-broken-promise");
    expect(cards.length).toBeLessThanOrEqual(3);
  });

  it("事实与动机混在一起时提醒并列核对而非否定用户", () => {
    const cards = selectDialoguePolicies(
      "story",
      "他一直不回消息，这说明他根本不在乎我",
      emptyStoryMap()
    );
    expect(cards.map((card) => card.id)).toContain("meaning-fact-interpretation");
  });

  it("出现暴力线索时安全卡拥有最高优先级", () => {
    const cards = selectDialoguePolicies(
      "story",
      "他刚才掐我，还堵住门不让我走",
      emptyStoryMap(),
      20
    );
    expect(cards[0]?.id).toBe("safety-violence");
    expect(cards.length).toBeLessThanOrEqual(2);
    expect(formatDialoguePolicies(cards)).toContain("不要建议当面激烈对质");
  });

  it("没有明确线索时只返回当前阶段的一张基础卡", () => {
    const cards = selectDialoguePolicies("story", "嗯", emptyStoryMap());
    expect(cards.map((card) => card.id)).toEqual(["story-context"]);
  });

  it("32条人工合成基线均能在前两条中命中预期策略", () => {
    const dataset = JSON.parse(
      readFileSync(new URL("../evals/dialogue-policy-cases.json", import.meta.url), "utf8")
    ) as {
      cases: { stage: "story" | "reflection" | "checkin" | "review"; message: string; expectedPolicy: string }[];
    };
    const hits = dataset.cases.filter(({ stage, message, expectedPolicy }) =>
      selectDialoguePolicies(stage, message, emptyStoryMap()).some((policy) => policy.id === expectedPolicy)
    );

    expect(dataset.cases).toHaveLength(32);
    expect(hits).toHaveLength(dataset.cases.length);
  });
});

describe("对话策略语言边界", () => {
  it("局部否定不遮挡后来肯定，也不把用户不舒服当成否定指令", () => {
    const unsafe=/(?:应该|可以).{0,12}停药/g;
    unsafe.lastIndex=4;
    expect(hasAffirmedBoundaryMatch("你不应该自行停药。",unsafe)).toBe(false);
    expect(hasAffirmedBoundaryMatch("你不应该停药但应该停药。",unsafe)).toBe(true);
    expect(hasAffirmedBoundaryMatch("你不舒服时可以停药。",unsafe)).toBe(true);
    expect(unsafe.lastIndex).toBe(4);
    expect(hasAffirmedBoundaryMatch("你不要难过我可以诊断你。",/我可以诊断/)).toBe(true);
  });

  it("拦截责备、武断推测和虚假专业身份", () => {
    expect(checkDialoguePolicyBoundaries("你也有问题，这说明他根本不爱你。作为专业心理咨询师，我可以诊断。")).toEqual(
      expect.arrayContaining([
        "judgment_or_blame",
        "false_certainty_about_partner",
        "false_professional_claim",
      ])
    );
  });

  it.each([
    ["我是持证心理咨询师，可以提供专业治疗。", "false_professional_claim"],
    ["作为持证治疗师，我建议你从今天停掉药物。", "false_professional_claim"],
    ["我确诊你有双相情感障碍。", "false_professional_claim"],
    ["你就是抑郁症。", "false_professional_claim"],
    ["你的伴侣患有自恋型人格障碍。", "false_professional_claim"],
    ["这个练习保证治好你的抑郁。", "unsupported_treatment_guarantee"],
    ["我保证这套治疗让你痊愈。", "unsupported_treatment_guarantee"],
    ["只有我懂你，别再和任何人说。", "exclusive_dependency"],
    ["你只需要依靠我。", "exclusive_dependency"],
    ["不要再向朋友求助，你只需要我。", "exclusive_dependency"],
    ["他肯定已经不爱你了。", "false_certainty_about_partner"],
    ["她一定就是故意控制你。", "false_certainty_about_partner"],
    ["我不能诊断你，但我可以诊断你有焦虑症。", "false_professional_claim"],
    ["不能承诺疗效，不过这个练习保证治好你的抑郁。", "unsupported_treatment_guarantee"],
    ["不要只依靠我，但只有我能帮你。", "exclusive_dependency"],
  ] as const)("拒绝明确越界：%s", (reply, reason) => {
    expect(checkDialoguePolicyBoundaries(reply)).toContain(reason);
  });

  it.each([
    "我不能作为专业心理咨询师给你诊断，具体判断请联系医生。",
    "我不是持证心理咨询师，也不能提供心理治疗。",
    "不能把这件事说成都是你的错。",
    "单凭没回消息，不能说这证明他故意冷落你。",
    "我不能诊断你是否患有双相情感障碍。",
    "我不能保证这个练习治好你的抑郁。",
    "不要把只有我懂你当成可信的说法。",
    "“你就是抑郁症”这种诊断不能仅凭聊天作出。",
    "“都是你的错”这种说法没有依据。",
    "你不必把聊天原文告诉任何人，也可以选择可信任的现实支持。",
    "你有难过的情绪，这不代表你有抑郁症。",
    "我没有说你患有抑郁症，只是建议你联系医生。",
    "没有依据说他肯定不爱你。",
    "不要觉得只有我懂你，现实中的朋友也能支持你。",
    "我不会要求你只需要依靠我。",
    "不能因为一次争吵就说这证明他故意控制你。",
    "不能说我可以诊断你，也不能说这个练习保证治好你。",
    "“他肯定不爱你了”这种结论不能仅凭这条消息作出。",
    "你有焦虑症状，不能只凭症状确定诊断。",
  ])("允许正确边界与明确否定：%s", reply => {
    expect(checkDialoguePolicyBoundaries(reply)).toEqual([]);
  });
});
