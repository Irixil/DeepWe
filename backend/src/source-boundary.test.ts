import { describe, expect, it } from "vitest";
import { guardPrivateReplyFidelity, ownerToPartnerDraftContextAllowed, SourceFidelityError } from "./source-fidelity";

const guard = (reply: string, currentMessage: string) => guardPrivateReplyFidelity(reply, { currentMessage, draftRanges: [] });

describe("同句主体和省略等待分句", () => {
  it.each([
    "你觉得自己被误解，也一直在等她回复。",
    "你很难过，还在等她回复。",
    "用户觉得难过，正在等对方回复。",
    "你想说清楚，而且一直在等她回复。",
    "你很难过，但一直在等她回复。",
  ])("无本人等待来源仍拒绝：%s", reply => {
    expect(() => guard(reply, "我觉得被误解，也知道她在等。")).toThrow(SourceFidelityError);
  });

  it.each(["我很难过，也一直在等她回复。", "我一直在等她回复。"])("显式与省略本人来源均可支持：%s", source => {
    for (const reply of ["你很难过，也一直在等她回复。", "你一直在等她回复。"])
      expect(guard(reply, source)).toBe(reply);
  });

  it.each([
    "她很着急，也一直在等你回复。",
    "你很难过，她很着急，也一直在等你回复。",
    "朋友很着急，也一直在等她回复。",
    "她知道朋友很难过，也一直在等同事回复。",
    "如果你感到难过，也一直在等她回复，可以先想想是否继续等。",
    "你很难过，也没有一直在等她回复。",
    "她说：“你觉得自己被误解，也一直在等她回复。”",
  ])("不把其他主体、条件、否定或引语当成本人肯定：%s", reply => {
    expect(guard(reply, "我想把情况讲清楚。")).toBe(reply);
  });

  it("句号后不盲继承前句主体，后句明确主体仍独立核对", () => {
    expect(guard("你觉得被误解。她也一直在等你回复。", "我知道她一直在等。")).toContain("她也一直在等");
    expect(() => guard("她很难过。你也一直在等她回复。", "我知道她一直在等。")).toThrow(SourceFidelityError);
  });

  it("继承的主体不能跨事件借用本人等待来源", () => {
    expect(() => guard("昨天你很难过，也一直在等她回复。", "今天我一直在等她回复。")).toThrow(SourceFidelityError);
  });

  it("来源里的引语不能提供省略本人等待的依据", () => {
    expect(() => guard("你很难过，也一直在等她回复。", "她说：‘我很难过，也一直在等她回复。’")).toThrow(SourceFidelityError);
  });

  it.each([
    "我很难过，也一直在等她回复，也没有在等她回复。",
    "我一直在等她回复，也不再等她回复。",
  ])("同事件后续省略否认优先，不再借旧肯定授权：%s", source => {
    expect(() => guard("你一直在等她回复。", source)).toThrow(SourceFidelityError);
  });

  it("不同事件的省略否认不抹掉有明确锚点的另一来源", () => {
    expect(guard("昨天你一直在等她回复。", "昨天我一直在等她回复。今天我很难过，也没有在等她回复。")).toBe("昨天你一直在等她回复。");
  });

  it.each([
    "我知道她很委屈，也一直在等我解释。",
    "我和朋友很难过，也一直在等她回复。",
  ])("嵌套或多人主体的省略等待不能自动当本人证据：%s", source => {
    expect(() => guard("你一直在等她回复。", source)).toThrow(SourceFidelityError);
  });

  it("输出的嵌套主体省略仍有歧义时拒绝，不帮模型补主语", () => {
    expect(() => guard("你知道她很委屈，也一直在等你解释。", "我一直在等她回复。")).toThrow(SourceFidelityError);
  });

  it("明确收件人宾语不改变本人等待主体", () => {
    expect(guard("你一直在等她回复。", "我给她发过消息，也一直在等她回复。")).toBe("你一直在等她回复。");
  });

  it("句尾的想念宾语不被误当成嵌套主体", () => {
    const reply = "你很想她，也一直在等她回复。";
    expect(guard(reply, "我一直在等她回复。")).toBe(reply);
  });

  it("分词器不可用时省略主体核对关闭，明确本人来源的旧路径保留", () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      expect(() => guard("你很难过，也一直在等她回复。", "我很难过，也一直在等她回复。")).toThrow(SourceFidelityError);
      expect(guard("你一直在等她回复。", "我一直在等她回复。")).toBe("你一直在等她回复。");
    } finally { Object.defineProperty(Intl, "Segmenter", { value: original, configurable: true }); }
  });

  it("结构化代写中的本人省略行动仍需本人依据，不能借伙伴等待", () => {
    const body = "我觉得被误解，也一直在等你回复。";
    const reply = `你可以这样说：\n“${body}”`;
    const start = reply.indexOf(body), draftRanges = [{ start, end: start + body.length }];
    expect(() => guardPrivateReplyFidelity(reply, { currentMessage: "我觉得被误解，也知道她一直在等。", draftRanges })).toThrow(SourceFidelityError);
    expect(guardPrivateReplyFidelity(reply, { currentMessage: "我觉得被误解，也一直在等她回复。", draftRanges })).toBe(reply);
  });
});

describe("伙伴收件人头和话语尾", () => {
  it.each([
    "只要一句发给她的话，不加前言。",
    "只要一句发给他的消息。",
    "帮我写给女友的话。",
    "写给她一段简短的话。",
    "请帮我写一句发给她。",
  ])("正常话语尾不改变明确伙伴收件人：%s", request => {
    expect(ownerToPartnerDraftContextAllowed(request)).toBe(true);
  });
  it.each([
    "只要一句发给她的同事的话，不加前言。",
    "写给她的朋友的话。",
    "发给其他人的话。",
    "发给她和同事的话。",
    "发给她的话，再写给同事。",
    "写给她一段简短的话给同事。",
    "发给她、他的消息。",
    "只想倾诉，不要帮我写给她的话。",
  ])("第三人、多个或拒绝代写不被话语尾豁免：%s", request => {
    expect(ownerToPartnerDraftContextAllowed(request)).toBe(false);
  });
});
