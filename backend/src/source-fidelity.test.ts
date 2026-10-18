import { describe, expect, it } from "vitest";
import {
  assertPrivateMotiveEvidence,
  SourceFidelityError,
  guardPrivateReplyFidelity,
  normalizePrivateNotesFidelity,
} from "./source-fidelity";

// Synthetic pure-function cases only. No worker, database, provider, or env imports.
type NoteKind = "user_statement" | "tentative_understanding" | "unknown";
const sourceId = "synthetic-user-source";
const causeNote = "用户因伴侣晚到而感到失落。";
const tentativePrefix = "尚未由用户确认的可能理解：";

function note(content: string, kind: NoteKind = "user_statement", ids = [sourceId]) {
  return { kind, content, sourceMessageIds: ids };
}

function notesContext(content: string) {
  return { messages: [{ id: sourceId, content, version: 1 }] };
}

const numericCorrectionId = "synthetic-numeric-correction";
function correctedNotesContext(before: string, after: string) {
  return { messages: [
    { id: sourceId, content: before, version: 1 },
    { id: numericCorrectionId, content: after, version: 1 },
  ] };
}

describe("私密回复的伴侣动机来源边界", () => {
  const source = "原定周六晚饭临时取消，对方说临时加班并让我别多想；我等了很久，心里很堵，想先理一下情绪。";

  it.each([
    "他是真的临时加班，还是只是在敷衍你？",
    "你会不会担心他嫌你事多？",
    "也许他只是找个借口挡一下。",
  ])("不允许把来源没有的负面动机选项带入追问：%s", reply => {
    expect(() => assertPrivateMotiveEvidence(reply, source)).toThrow(SourceFidelityError);
  });

  it("保留用户明确提出的担忧、伴侣原话线索和普通情绪探索", () => {
    expect(() => assertPrivateMotiveEvidence("你担心他嫌你事多，这份担心本身让你更难受。", "我担心他觉得我事多。")).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("他说怕冲突，也许这能解释一部分，但未必是全部。", "他说自己怕冲突。")).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("这次安排突然变化，哪一部分让你最堵？", source)).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("你希望下次安排变动时能早点告诉你。", "请帮我写一句，下次安排变动时希望他早点告诉我。")).not.toThrow();
  });

  it("保留条件式沟通分析和有来源的本人意图，仍拒绝新添的伴侣动机", () => {
    const current = "我想把当时情况讲清楚，不想跟她互相指责。";
    expect(() => assertPrivateMotiveEvidence(
      "如果一上来就解释，很容易被听成在证明自己没错。",
      current,
    )).not.toThrow();
    expect(() => assertPrivateMotiveEvidence(
      "你想把当时情况讲清楚，同时不想让谈话变成互相指责。",
      current,
    )).not.toThrow();
    expect(() => assertPrivateMotiveEvidence(
      "她是故意让你难受。",
      current,
    )).toThrow(SourceFidelityError);
  });

  it("允许带清楚来源的伴侣引语，不把引语里的我怕当成本人担忧", () => {
    expect(() => assertPrivateMotiveEvidence(
      "按你转述的原话，他说当时怕你生气，所以没有解释清楚；这只是他提供的解释。",
      "他跟我说：“我当时怕你生气，所以没解释清楚。”",
    )).not.toThrow();
    expect(() => assertPrivateMotiveEvidence(
      "按你转述，他说怕你生气；这是他提供的解释。",
      "他跟我说：“我怕你生气，所以没解释清楚。”",
    )).not.toThrow();
    expect(() => assertPrivateMotiveEvidence(
      "他怕你生气。",
      "他跟我说：“我怕你生气，所以没解释清楚。”",
    )).toThrow(SourceFidelityError);
  });

  it("允许以伴侣为宾语的一般沟通建议", () => {
    expect(() => assertPrivateMotiveEvidence(
      "面对他时，可以先表达你的感受，避免用沉默惩罚他。",
      "我们争吵后我沉默了，我想换个沟通方法。",
    )).not.toThrow();
  });

  it("允许明确安全行为判断", () => {
    expect(() => assertPrivateMotiveEvidence(
      "他拿走手机、阻止离开这些行为不尊重你的边界，需要先考虑安全。",
      "伴侣拿走我手机，堵着门不让我离开。",
    )).not.toThrow();
  });

  it("允许当前明确承接的有效本人历史报告，纠正和新事件则切断旧线索", () => {
    const history = ["他解释说怕我生气。"];
    const reply = "按你刚才转述，他说当时怕你生气；那是他提供的解释。";
    expect(() => assertPrivateMotiveEvidence(reply, "我想接着理一理这件事。", history)).not.toThrow();
    expect(() => assertPrivateMotiveEvidence(reply, "更正，他没有说过怕我生气；我想接着理一理这件事。", history)).toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence(reply, "我想接着理一理这件事，但今天他堵住了门。", history)).toThrow(SourceFidelityError);
  });

  it("不把同句里仅作为宾语出现的伴侣变成动机证据", () => {
    expect(() => assertPrivateMotiveEvidence("他说当时怕你生气。", "我跟他聊天时，我怕你生气，所以没解释。"))
      .toThrow(SourceFidelityError);
  });

  it("不把用户担心升级为伴侣事实，也不把伴侣理由扩成确定动机", () => {
    expect(() => assertPrivateMotiveEvidence("他就是嫌你事多。", "我担心他觉得我事多。"))
      .toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence("他怕冲突。", "他说自己怕冲突。"))
      .toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence("也许他怕冲突，但这未必能解释全部。", "他说自己怕冲突。"))
      .not.toThrow();
  });

  it("A2 明确不想认定的动机不授权肯定事实，保留正常否定表达", () => {
    const current = "我不想直接认定他不在乎我。";
    expect(() => assertPrivateMotiveEvidence("他不在乎你。", current)).toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence("也许他不在乎你。", current)).toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence("不能据此认定他不在乎你。", current)).not.toThrow();
  });

  it("忽略被明确标为不下结论的引述，同时继续拦截同句后续的肯定动机", () => {
    expect(() => assertPrivateMotiveEvidence(
      "我不替他下‘在不在乎’的结论。",
      "这次安排让我难受，原因还不知道。",
    )).not.toThrow();
    expect(() => assertPrivateMotiveEvidence(
      "我不替他下‘在不在乎’的结论，但他就是故意伤害你。",
      "这次安排让我难受，原因还不知道。",
    )).toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence(
      "他不是不在乎你，而是故意伤害你。",
      "我担心他不在乎我。",
    )).toThrow(SourceFidelityError);
  });

  it.each([
    "我不替他辩解所以才下‘他故意伤害你’的结论。",
    "我不为他辩解而作出‘他故意伤害你’的结论。",
  ])("否定辩解不能错误地支配后面的动机结论：%s", reply => {
    expect(() => assertPrivateMotiveEvidence(
      reply,
      "这次安排让我难受，原因还不知道。",
    )).toThrow(SourceFidelityError);
  });

  it("保留直接受“不替”支配的轻微程度副词", () => {
    expect(() => assertPrivateMotiveEvidence(
      "我不替他轻易下‘他故意伤害你’的结论。",
      "这次安排让我难受，原因还不知道。",
    )).not.toThrow();
  });

  it("不扫描一般建议、本人感受、条件表达和明确安全行为", () => {
    expect(() => assertPrivateMotiveEvidence("不要用沉默惩罚对方。", "我很难受，不想继续争吵。")).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("如果对方故意敷衍你，可以先问清楚再决定。", "我还不知道他为什么没回复。")).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("他不是故意敷衍你。", "我不知道他为什么没回复。")).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("我觉得被挡住，很受伤。", "他刚才挡住门，不让我出去。")).not.toThrow();
    expect(() => assertPrivateMotiveEvidence("他限制你出门并威胁你，这些行为需要优先考虑安全。", "他限制我出门并威胁我。")).not.toThrow();
  });

  it("只用本轮同一事件的本人线索，且当前纠正优先于旧担忧", () => {
    expect(() => assertPrivateMotiveEvidence(
      "这次他可能是不在乎你。",
      "上次我担心他不在乎我。这次他临时加班取消晚饭。",
    )).toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence(
      "你担心他嫌你事多。",
      "更正，我不再担心他觉得我事多；现在只想讨论这次安排怎么变的。",
    )).toThrow(SourceFidelityError);
    expect(() => assertPrivateMotiveEvidence(
      "上次你担心他嫌你事多；这次他有明确的工作原因。",
      "上次我担心他觉得我事多。这次他说临时加班。",
    )).not.toThrow();
  });
});

describe("私密回复的有限等待前提校验", () => {
  const currentMessage = "伴侣晚到了，我感到失落，原因还不知道。";

  it("只中性化未获来源支持的第二人称等待时间附加语", () => {
    expect(guardPrivateReplyFidelity("你在等待时感到失落，值得慢慢说清楚。", { currentMessage }))
      .toBe("你当时感到失落，值得慢慢说清楚。");
  });

  it("第一人称代写中性化等待附加语并保留原句数与其他内容", () => {
    expect(guardPrivateReplyFidelity("我在等的时候感到失落。我只是想表达当时的感觉。", { currentMessage }))
      .toBe("我当时感到失落。我只是想表达当时的感觉。");
  });

  it.each(["你在等待时感到失落。", "我在等的时候感到失落。"])(
    "本轮本人明确肯定等待时保留合法表达：%s", reply => {
      expect(guardPrivateReplyFidelity(reply, {
        currentMessage: "我当时在等伴侣，感到失落。",
      })).toBe(reply);
    },
  );

  it("另一天的等待经历不授权本轮的等待断言", () => {
    expect(guardPrivateReplyFidelity("你在等待时感到失落。", {
      currentMessage,
      priorUserMessages: [{ id: "synthetic-other-day", content: "上个月有一次我在等伴侣。", version: 1 }],
    })).toBe("你当时感到失落。");
  });

  it("当前明确否认优先于旧用户消息中的肯定等待", () => {
    expect(guardPrivateReplyFidelity("我在等的时候感到失落。", {
      currentMessage: "更正一下：我当时没有等伴侣，我是后来才到的，其他事实不变。我感到失落。",
      priorUserMessages: [{ id: "synthetic-old-report", content: "我当时一直在等伴侣。", version: 1 }],
    })).toBe("我当时感到失落。");
  });

  it("第三方等待不授权用户自己的等待附加语", () => {
    expect(guardPrivateReplyFidelity("你在等待时感到失落。", {
      currentMessage: "姐姐说她在等待时很焦虑。我只是对伴侣晚到感到失落。",
    })).toBe("你当时感到失落。");
  });

  it("本轮关于等待的假设不变成本人已等待的依据", () => {
    expect(guardPrivateReplyFidelity("你在等待时感到失落。", {
      currentMessage: "如果我在等待，我可能会焦虑；但这次我没有等，只是感到失落。",
    })).toBe("你当时感到失落。");
  });

  it("本人关于等待的疑问句不授权肯定等待", () => {
    expect(guardPrivateReplyFidelity("你在等待时感到失落。", {
      currentMessage: "我在等回复吗？",
    })).toBe("你当时感到失落。");
  });

  it.each([
    "如果你在等待时感到失落，可以先写下这种感受。",
    "也许你在等待时会有期待落差，是否如此还需要你核对。",
    "不能据此认定你在等待时一直焦虑。",
  ])("局部条件、可能和否定不被改成确定事实：%s", reply => {
    expect(guardPrivateReplyFidelity(reply, { currentMessage })).toBe(reply);
  });

  it("无法安全拆分的嵌入式等待前提拒绝，不能删词后发布", () => {
    expect(() => guardPrivateReplyFidelity("我知道你在等待时感到难受。", { currentMessage }))
      .toThrow(SourceFidelityError);
  });

  it("没有来源的独立等待行动断言拒绝", () => {
    expect(() => guardPrivateReplyFidelity("你当时一直在等伴侣。", { currentMessage }))
      .toThrow(SourceFidelityError);
  });

  it("不涉及等待前提的正常回复原样保留", () => {
    const reply = "你说自己感到失落，迟到原因还不知道，可以先把这两件事分开。";
    expect(guardPrivateReplyFidelity(reply, { currentMessage })).toBe(reply);
  });

  it("明确的第一人称代写可转述本人已确认的伴侣等待", () => {
    const source = "周六晚饭那天，我也知道她一直在等我。";
    const reply = "如果要用一段话开头，可以这样说：‘周六晚饭，我知道你一直在等。’";
    expect(guardPrivateReplyFidelity(reply, { currentMessage: source })).toBe(reply);
  });

  it.each([
    "如果你想发消息，可以先用这个意思：‘你一直在等，这个我知道。’",
    "如果你想发消息，可以先用这个意思：‘我知道你一直在等。’",
  ])("自然条件主语和同句知识前后置都绑定到唯一伴侣：%s", reply => {
    const currentMessage = "我觉得自己被误解了，也知道她一直在等。";
    expect(guardPrivateReplyFidelity(reply, { currentMessage })).toBe(reply);
  });

  it.each([
    "如果你想发消息，可以先用这个意思：‘你一直在等。我知道。’",
    "如果你想发消息，可以先用这个意思：‘你一直在等，这个我不知道。’",
    "如果你想发消息，可以先用这个意思：‘你一直在等，这个我不确定。’",
  ])("跨句或否定知识不能支持等待代写：%s", reply => {
    expect(() => guardPrivateReplyFidelity(reply, {
      currentMessage: "我知道她一直在等。",
    })).toThrow(SourceFidelityError);
  });

  it("没有唯一伴侣来源或收件人含糊时不借用户本人等待兜底", () => {
    const reply = "如果你想发消息，可以先用这个意思：‘你一直在等，这个我知道。’";
    for (const currentMessage of [
      "我一直在等她。",
      "我知道她一直在等，也知道他一直在等。",
      "我觉得自己被误解了。",
    ]) {
      expect(() => guardPrivateReplyFidelity(reply, { currentMessage })).toThrow(SourceFidelityError);
    }
  });

  it("来源里出现明确的第三方收件意图时，不把省略收件人的草稿绑定给伴侣", () => {
    const reply = "如果你想发消息，可以先用这个意思：‘你一直在等，这个我知道。’";
    for (const currentMessage of [
      "我知道她一直在等，但我这次想给朋友发消息。",
      "我知道她一直在等，但我想给其他人发消息。",
      "我知道她一直在等，但我想给她同事发消息。",
      "我知道她一直在等，但我想给我的女朋友的同事发消息。",
      "我知道其他人一直在等。",
      "我知道她同事一直在等。",
    ]) {
      expect(() => guardPrivateReplyFidelity(reply, { currentMessage })).toThrow(SourceFidelityError);
    }
  });

  it("来源明确想给伴侣发消息时，省略收件人的本人草稿仍可对齐", () => {
    const reply = "如果你想发消息，可以先用这个意思：‘你一直在等，这个我知道。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "我知道她一直在等，也想给她发消息。",
    })).toBe(reply);
  });

  it("带消息对象的本人代写引导仍把完整收件人识别为伴侣", () => {
    const currentMessage = "我知道她一直在等。";
    for (const introduction of [
      "你可以给她写这样一段话：",
      "你可以发给她这段文字：",
      "你可以对她说一段这样的开场：",
    ]) {
      const reply = `${introduction}‘我知道你一直在等。’`;
      expect(guardPrivateReplyFidelity(reply, { currentMessage })).toBe(reply);
    }
    for (const introduction of [
      "你可以给其他人写这样一段话：",
      "你可以发给她同事这段文字：",
      "你可以对她本人说一段这样的开场：",
    ]) {
      expect(() => guardPrivateReplyFidelity(`${introduction}‘我知道你一直在等。’`, { currentMessage }))
        .toThrow(SourceFidelityError);
    }
  });

  it("明确的本人致因仍需同一事件的因果来源", () => {
    const reply = "你可以对她说：‘周六我没有解释清楚，让你一直在等，这个我知道。’";
    expect(() => guardPrivateReplyFidelity(reply, {
      currentMessage: "周六晚饭那天，我知道她一直在等我。",
    })).toThrow(SourceFidelityError);
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六晚饭那天，我让她一直等我，因为我没有解释清楚。",
    })).toBe(reply);
  });

  it.each([
    "如果你想发消息，可以先用这个意思：‘你一直在等，这个我知道，是我没解释清楚导致的。’",
    "如果你想发消息，可以先用这个意思：‘我知道你一直在等，是因为我没讲清楚。’",
  ])("等待事实后的无来源因果仍拒绝：%s", reply => {
    expect(() => guardPrivateReplyFidelity(reply, {
      currentMessage: "我觉得自己被误解了，也知道她一直在等。",
    })).toThrow(SourceFidelityError);
  });

  it("来源明确把未及时说明与伴侣等待相连时，允许忠实保留同一因果", () => {
    const reply = "你可以这样说：‘我知道是我没及时说明变更让你一直在等。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "我没及时说明变更，让她一直在等，这件事我知道。",
    })).toBe(reply);
  });

  it("否定式原因仍可成为明确肯定的因果前件；转述和不确定原因不能", () => {
    const reply = "你可以对她说：‘我没解释清楚让你一直在等，这个我知道。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "我没解释清楚让她一直在等，这件事我知道。",
    })).toBe(reply);
    for (const currentMessage of [
      "她说我没解释清楚让她一直在等。",
      "我不确定是不是我没解释清楚让她一直在等。",
    ]) {
      expect(() => guardPrivateReplyFidelity(reply, { currentMessage })).toThrow(SourceFidelityError);
    }
  });

  it("同一结果的另一原因和明确否认，均不能支持稿中新增的解释原因", () => {
    const reply = "你可以对她说：‘周六我没有解释清楚，让你一直在等，这个我知道。’";
    for (const currentMessage of [
      "周六我晚到，让她一直在等。",
      "周六我晚到，让她一直在等。我当时没有解释清楚，但等待不是没解释造成的。",
    ]) {
      expect(() => guardPrivateReplyFidelity(reply, { currentMessage })).toThrow(SourceFidelityError);
    }
  });

  it("同一事件明确否认同一因果时覆盖旧肯定，不同原因的否认不抹去已肯定原因", () => {
    const reply = "你可以对她说：‘周六我晚到让你一直在等，我知道。’";
    expect(() => guardPrivateReplyFidelity(reply, {
      currentMessage: "周六我晚到，让她一直在等。后来我更正：等待不是晚到造成的。",
    })).toThrow(SourceFidelityError);
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六我晚到，让她一直在等。等待不是没解释造成的。",
    })).toBe(reply);
  });

  it("当前本人原话中后来的唯一等待关系指代更正撤销旧因果许可", () => {
    const reply = "你可以对她说：‘周六我没解释清楚，让你一直在等，这个我知道。’";
    for (const currentMessage of [
      "周六我没解释清楚，让她一直在等。但后来我更正了，这不是因为我没解释清楚。",
      "周六我没解释清楚，让她一直在等。其实这不是因为我没解释清楚。",
      "周六我没解释清楚，让她一直在等。这不是因为我没解释清楚。也许我没解释清楚让她一直在等。",
    ]) {
      expect(() => guardPrivateReplyFidelity(reply, { currentMessage })).toThrow(SourceFidelityError);
    }
  });

  it("另一结果的否认不撤销等待关系，多候选的指代则不能保留许可", () => {
    const reply = "你可以对她说：‘周六我晚到让你一直在等，我知道。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六我晚到让她一直在等。她的难过不是晚到造成的。",
    })).toBe(reply);
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六我晚到让她一直在等。周六我没解释让她难过。其实这不是因为我没解释。",
    })).toBe(reply);
    expect(() => guardPrivateReplyFidelity(reply, {
      currentMessage: "周六我晚到让她一直在等，我没解释让她难过。其实这不是因为我晚到。",
    })).toThrow(SourceFidelityError);
  });

  it("后置因为与当前明确的同原因来源对应", () => {
    const reply = "如果你想发消息，可以先用这个意思：‘我知道你一直在等，是因为我没讲清楚。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "我没讲清楚，让她一直在等。",
    })).toBe(reply);
  });

  it("等待事实后的希望表达不被当作致因，普通假设与建议保持可用", () => {
    const reply = "你可以对她说：‘我知道你一直在等，所以我希望把话讲清楚。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六晚饭那天，我知道她一直在等我。",
    })).toBe(reply);
    expect(guardPrivateReplyFidelity("如果你担心自己没解释清楚，可以先问她愿不愿意继续聊。", {
      currentMessage: "我觉得自己被误解了，也知道她一直在等。",
    })).toBe("如果你担心自己没解释清楚，可以先问她愿不愿意继续聊。");
  });

  it.each([
    "可以把开场压短，比如发：\n\n“周六那顿饭的事，我想跟你说清楚。我知道你一直在等。”",
    "你可以先给她写：‘我知道你一直在等。’",
    "你可以把第一句写给她：‘我知道你一直在等。’",
    "可以先发：‘我知道你一直在等。’",
    "你可以先开口：‘我知道你一直在等。’",
    "可以先这样开场：‘我知道你一直在等。’",
    "你可以先说：‘我知道你一直在等。’",
    "你可以参考这个建议这样说：‘我知道你一直在等。’",
    "你可以按自己的原话这样说：‘我知道你一直在等。’",
    "你可以先核对一下措辞再这样说：‘我知道你一直在等。’",
    "你可以先面对自己的想法，再这样说：‘我知道你一直在等。’",
    "你可以先面对自己的想法再这样说：‘我知道你一直在等。’",
    "你可以参考朋友的建议再这样说：‘我知道你一直在等。’",
    "你可以试试这段话：‘我知道你一直在等。’",
    "给她的消息可以这样写：‘我知道你一直在等。’",
  ])("自然代写引导承接当前来源里的伴侣等待：%s", reply => {
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六晚饭那天，我临时加班。我知道她一直在等我。",
    })).toBe(reply);
  });

  it.each([
    "你可以给朋友发：‘我知道你一直在等。’",
    "你朋友可以先发：‘我知道你一直在等。’",
    "你可以对同事说：‘我知道你一直在等。’",
    "你可以给张三写：‘我知道你一直在等。’",
    "你可以对小王说：‘我知道你一直在等。’",
    "你可以对张三说：‘我知道你一直在等。’",
    "你可以跟李四讲：‘我知道你一直在等。’",
    "你可以对朋友这样说：‘我知道你一直在等。’",
    "你可以对她的朋友说：‘我知道你一直在等。’",
    "她给你的消息可以这样写：‘我知道你一直在等。’",
    "可以把开场压短，给朋友发：‘我知道你一直在等。’",
    "你可以让她发：‘我知道你一直在等。’",
    "她可以先发：‘我知道你一直在等。’",
    "你可以引用她的话再发：‘我知道你一直在等。’",
    "你可以先复述她刚才那段，再发：‘我知道你一直在等。’",
    "你可以回想她这样说：‘我知道你一直在等。’",
    "你可以帮她这样开头：‘我知道你一直在等。’",
  ])("第三人、伴侣发言或转述不作为本人代写：%s", reply => {
    expect(() => guardPrivateReplyFidelity(reply, {
      currentMessage: "周六晚饭那天，我知道她一直在等我。",
    })).toThrow(SourceFidelityError);
  });

  it.each([
    "周六晚饭那天，我一直在等她。",
    "周六晚饭那天，她是否一直在等我，我不知道。",
    "周六晚饭那天，她没有一直在等我。",
    "上周她一直在等我。今天周六晚饭我临时加班。",
    "周六她一直在等我。周六她又一直在等我。",
  ])("自然代写仍须当前、肯定且唯一的伴侣等待来源：%s", currentMessage => {
    expect(() => guardPrivateReplyFidelity("可以把开场压短，比如发：‘我知道你一直在等。’", { currentMessage }))
      .toThrow(SourceFidelityError);
  });

  it.each([
    ["ownerWait", "周六晚饭那天，我一直在等她。"],
    ["partnerWait", "周六晚饭那天，我知道她一直在等我。"],
    ["both", "周六晚饭那天，我一直在等她。我知道她一直在等我。"],
    ["neither", "周六晚饭那天，我们约了晚饭。"],
  ])("明确第三人或未知收件人不能借 %s 来源回退", (_label, currentMessage) => {
    for (const introduction of [
      "你可以稍后对朋友说：", "你可以稍后对张三说：",
      "你可以稍后跟李四讲：", "你可以随后向同事说：",
      "你可以对她的朋友说：", "你可以给一位不确定身份的人写：",
    ]) {
      expect(() => guardPrivateReplyFidelity(introduction + "‘我知道你一直在等。’", { currentMessage }))
        .toThrow(SourceFidelityError);
    }
  });

  it.each(["给她的话这样写：", "给她的消息可以这样写：", "你可以试试这段话："])(
    "本人向伴侣发出的自然话术仍可承接肯定来源：%s", introduction => {
      const reply = introduction + "‘我知道你一直在等。’";
      expect(guardPrivateReplyFidelity(reply, { currentMessage: "周六晚饭那天，我知道她一直在等我。" })).toBe(reply);
    },
  );

  it.each(["她给你的消息这样写：", "伴侣可以给你这样写："])(
    "伴侣发给本人的内容不是本人代写：%s", introduction => {
      expect(() => guardPrivateReplyFidelity(introduction + "‘我知道你一直在等。’", {
        currentMessage: "周六晚饭那天，我一直在等她。我知道她一直在等我。",
      })).toThrow(SourceFidelityError);
    },
  );

  it("词界不可用时阻断引号代写，不影响有来源的普通本人回应", () => {
    const source = "周六晚饭那天，我一直在等她。我知道她一直在等我。";
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    try {
      expect(() => guardPrivateReplyFidelity("你可以对她说：‘我知道你一直在等。’", { currentMessage: source }))
        .toThrow(SourceFidelityError);
      expect(guardPrivateReplyFidelity("你一直在等。", { currentMessage: source })).toBe("你一直在等。");
    } finally {
      Object.defineProperty(Intl, "Segmenter", { configurable: true, value: original });
    }
  });

  it("引号不成对时不借本人等待来源回退", () => {
    expect(() => guardPrivateReplyFidelity("你可以对她说：“我知道你一直在等。", {
      currentMessage: "周六晚饭那天，我一直在等她。我知道她一直在等我。",
    })).toThrow(SourceFidelityError);
  });

  it("明确对伴侣代写中的明白承接伴侣等待，不能借本人等待兜底", () => {
    const reply = "你可以对她写：‘我明白你一直在等。’";
    expect(guardPrivateReplyFidelity(reply, {
      currentMessage: "周六晚饭那天，我知道她一直在等我。",
    })).toBe(reply);
    for (const currentMessage of [
      "周六晚饭那天，我一直在等她。",
      "周六晚饭那天，我不知道她是否一直在等我。",
      "周六晚饭那天，她没有一直在等我。",
    ]) {
      expect(() => guardPrivateReplyFidelity(reply, { currentMessage })).toThrow(SourceFidelityError);
    }
    expect(() => guardPrivateReplyFidelity("你可以对她写：‘我感觉你一直在等。’", {
      currentMessage: "周六晚饭那天，我一直在等她。",
    })).toThrow(SourceFidelityError);
  });

  it("代写省略日期时只承接唯一来源事件，旧的本人等待匹配范围不变", () => {
    const noDateDraft = "你可以这样说：‘我知道你一直在等。’";
    expect(guardPrivateReplyFidelity(noDateDraft, {
      currentMessage: "周六晚饭那天，我也知道她一直在等我。",
    })).toBe(noDateDraft);
    expect(() => guardPrivateReplyFidelity(noDateDraft, {
      currentMessage: "上周她一直在等我。今天周六我加班想解释。",
    })).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity(
      "你可以这样说：‘上周，我知道你一直在等。’",
      { currentMessage: "周六晚饭那天，我也知道她一直在等我。" },
    )).toThrow(SourceFidelityError);
    const existingOwnerCase = "周六你一直在等。";
    expect(guardPrivateReplyFidelity(existingOwnerCase, {
      currentMessage: "我上周一直在等她。",
    })).toBe(existingOwnerCase);
  });

  it("保留同名相对锚点，并承接已建立唯一事件的跨句回指", () => {
    const reply = "你可以这样说：‘那天你一直在等，这个我知道。’";
    for (const currentMessage of [
      "那天我知道她一直在等。",
      "我们约定周六吃饭，那天我临时加班。我当时没解释。我知道她一直在等。",
    ]) expect(guardPrivateReplyFidelity(reply, { currentMessage })).toBe(reply);
  });

  it.each([
    "周五我们约好吃饭。周六那天我加班。我知道她一直在等。",
    "周六那天我加班。第二天我知道她一直在等。",
    "周六那天我加班。两天后我知道她一直在等。",
    "周六那天我加班。过了三天，我知道她一直在等。",
    "周六那天我加班。今天我知道她一直在等。",
    "周六那天我加班。昨天我知道她一直在等。",
    "周六我们约好吃饭。那天我知道她一直在等。",
    "朋友说周六那天我加班。我知道她一直在等。",
    "如果周六那天我加班。我知道她一直在等。",
    "不是周六那天我加班。我知道她一直在等。",
    "我引用‘周六那天我加班’。我知道她一直在等。",
    "周六那天我加班。我不知道她是否一直在等。",
    "周六那天我加班。她说她一直在等。",
    "周六那天我加班。如果她一直在等，我想解释。",
    "周六那天我加班。她没有一直在等。",
  ])("不把新事件或非本人肯定来源用作跨句日期别名：%s", (currentMessage) => {
    expect(() => guardPrivateReplyFidelity("你可以这样说：‘那天你一直在等，这个我知道。’", { currentMessage }))
      .toThrow(SourceFidelityError);
  });

  it.each(["那晚", "今天"])("跨句日期别名不补造不同日期：%s", (anchor) => {
    expect(() => guardPrivateReplyFidelity(`你可以这样说：‘${anchor}你一直在等，这个我知道。’`, {
      currentMessage: "周六那天我加班。我知道她一直在等。",
    })).toThrow(SourceFidelityError);
  });

  it("没有日期和重复同一日期时，保留明确由本人对伴侣说的自然代写", () => {
    const noDateSource = "我知道她一直在等我。我想解释但不互相指责。";
    const draft = "‘我知道你一直在等。’";
    for (const introduction of ["你可以这样说：", "你可以这样开头：", "你可以对她说："]) {
      expect(guardPrivateReplyFidelity(introduction + draft, { currentMessage: noDateSource }))
        .toBe(introduction + draft);
    }
    expect(guardPrivateReplyFidelity("你可以这样说：" + draft, {
      currentMessage: "周六我加班。周六我知道她一直在等我。",
    })).toBe("你可以这样说：" + draft);
  });

  it("无日期代写仍拒绝不确定来源、跨事件、换发言者和捏造本人等待", () => {
    const draft = "你可以对她说：‘我知道你一直在等。’";
    for (const source of [
      "我不知道她是否一直在等我。",
      "不是她一直在等我，是我在等她。",
      "朋友说她一直在等我。",
      "她一直在等我吗？",
      "她说‘我一直在等你。’",
      "上周她一直在等我。今天周六我加班想解释。",
      "上周她一直在等我。这次我加班想解释。",
    ]) {
      expect(() => guardPrivateReplyFidelity(draft, { currentMessage: source }))
        .toThrow(SourceFidelityError);
    }
    const source = "我知道她一直在等我。";
    expect(() => guardPrivateReplyFidelity("你可以让伴侣这样说：‘我知道你一直在等。’", { currentMessage: source }))
      .toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你可以建议她这样说：‘我知道你一直在等。’", { currentMessage: source }))
      .toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你可以替她这样说：‘我知道你一直在等。’", { currentMessage: source }))
      .toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你可以这样说：‘我那晚一直在等你。’", { currentMessage: source }))
      .toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity("你可以这样说：‘周六我知道你一直在等。’", { currentMessage: source }))
      .toThrow(SourceFidelityError);
  });

  it.each([
    "周六晚饭那天，我不确定她有没有等我。",
    "周六晚饭那天，我知道她没有等我。",
    "周六晚饭那天，我觉得她可能在等我。",
    "周六晚饭那天，她跟我说她一直在等我。",
    "周六晚饭那天，她让我等了一会儿。",
    "周六晚饭那天，不是她一直在等我，是我一直在等她。",
    "周六晚饭那天，我没有说她一直在等我。",
    "周六晚饭那天，别说她一直在等我。",
    "周六晚饭那天，更正：她没有等我。",
    "周六晚饭那天，她一直在等我吗？",
    "周六晚饭那天，听说她一直在等我。",
    "周六晚饭那天，据说她一直在等我。",
    "周六晚饭那天，朋友说她一直在等我。",
    "周六晚饭那天，她说‘我一直在等你。’",
    "周六晚饭那天她没等我；上周我知道她在等我。",
  ])("否定、推测、疑问、转述或另一事件不能授权代写肯定句：%s", source => {
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：‘周六晚饭，我知道你一直在等。’",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
  });

  it("普通第二人称描述和本人未说过的第一人称等待仍被拒绝", () => {
    const source = "周六晚饭那天，我也知道她一直在等我。";
    expect(() => guardPrivateReplyFidelity("你一直在等。", { currentMessage: source }))
      .toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：‘我那晚一直在等你。’",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
  });

  it("只有当前用户作为代写发言者时才重判引号人称", () => {
    const source = "周六晚饭那天，我也知道她一直在等我。";
    expect(() => guardPrivateReplyFidelity(
      "伴侣可以这样说：‘我知道你一直在等。’",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：‘第一句。’\n\n另一个例子：‘周六晚饭，我知道你一直在等。’",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：“周六晚饭，我知道你一直在等。",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
  });

  it("只识别引号类型正确的代写文本，并保留有效的双引号内单引号", () => {
    const source = "周六晚饭那天，我也知道她一直在等我。";
    const validNested = "如果要用一段话开头，可以这样说：“周六晚饭，我知道你一直在等；我发‘别多想’是想解释工作安排。”";
    expect(guardPrivateReplyFidelity(validNested, { currentMessage: source })).toBe(validNested);
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：“周六晚饭，我知道你一直在等。’",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：“周六晚饭，我知道你一直在等；‘继续”以后’。",
      { currentMessage: source },
    )).toThrow(SourceFidelityError);
  });

  it("不同历史事件不能授权当前代写中的伴侣等待", () => {
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：‘周六晚饭，我知道你一直在等。’",
      {
        currentMessage: "这次安排让我有点难受。",
        priorUserMessages: [{ id: "synthetic-prior", content: "上周，我知道她一直在等我。", version: 1 }],
      },
    )).toThrow(SourceFidelityError);
  });

  it("同一条消息里的旧事件也不能支持当前事件", () => {
    expect(() => guardPrivateReplyFidelity(
      "如果要用一段话开头，可以这样说：‘周六晚饭，我知道你一直在等。’",
      { currentMessage: "上周她一直在等我。今天周六晚饭我临时加班，想解释。" },
    )).toThrow(SourceFidelityError);
  });
});

describe("私密笔记的完整来源校验", () => {
  it("显式空数组合法，不把无笔记误判为失败", () => {
    expect(normalizePrivateNotesFidelity([], { messages: [] })).toEqual([]);
  });

  it("有效原话笔记与用户明确提出的未知保留", () => {
    const raw = [note("我感到失落。"), note("我还不知道原因。", "unknown")];
    expect(normalizePrivateNotesFidelity(raw, notesContext("我感到失落。我还不知道原因。")))
      .toEqual(raw);
  });

  it.each([null, {}, { notes: [] }, "notes", [null]])("坏顶层或条目结构整批拒绝：%j", raw => {
    expect(() => normalizePrivateNotesFidelity(raw, notesContext("合成用户原话。")))
      .toThrow(SourceFidelityError);
  });

  it.each([
    { kind: "known_fact", content: "合成用户原话。", sourceMessageIds: [sourceId] },
    { kind: "user_statement", content: 42, sourceMessageIds: [sourceId] },
    { kind: "user_statement", content: " \n ", sourceMessageIds: [sourceId] },
    { kind: "user_statement", content: "合成用户原话。", sourceMessageIds: [] },
    { kind: "user_statement", content: "合成用户原话。", sourceMessageIds: sourceId },
  ])("不合格字段不被过滤成成功空数组：%j", invalid => {
    expect(() => normalizePrivateNotesFidelity([invalid], notesContext("合成用户原话。")))
      .toThrow(SourceFidelityError);
  });

  it("混入无效来源 ID 时整批拒绝，不能保留有效 ID 洗掉无效来源", () => {
    const raw = [note("我感到失落。"), note("另一条内容。", "user_statement", [sourceId, "missing-source"])];
    expect(() => normalizePrivateNotesFidelity(raw, notesContext("我感到失落。")))
      .toThrow(SourceFidelityError);
    expect(raw[1]!.sourceMessageIds).toEqual([sourceId, "missing-source"]);
  });

  it("数值来源 ID 不能通过字符串强制转换获得授权", () => {
    expect(() => normalizePrivateNotesFidelity([
      { kind: "user_statement", content: "合成原话。", sourceMessageIds: [7] },
    ], { messages: [{ id: "7", content: "合成原话。", version: 1 }] }))
      .toThrow(SourceFidelityError);
  });

  it("1000字符完整正文合法，超限正文整批拒绝且不截断", () => {
    const exact = "甲".repeat(1000);
    expect(normalizePrivateNotesFidelity([note(exact)], notesContext(exact))).toEqual([note(exact)]);
    expect(() => normalizePrivateNotesFidelity([note("我感到失落。"), note(exact + "但")], notesContext(exact + "但")))
      .toThrow(SourceFidelityError);
  });

  it("两端明确但仅相邻陈述时，因果笔记降为带显式前缀的暂定理解", () => {
    expect(normalizePrivateNotesFidelity([note(causeNote)], notesContext("伴侣晚到了。我感到失落。")))
      .toEqual([note(tentativePrefix + causeNote, "tentative_understanding")]);
  });

  it("本人使用同原语法明确确认因果时保留user_statement", () => {
    expect(normalizePrivateNotesFidelity([note(causeNote)], notesContext("我因伴侣晚到而感到失落。")))
      .toEqual([note(causeNote)]);
  });

  it.each([
    { source: "我因为伴侣晚到而感到失落。", content: causeNote },
    { source: "伴侣晚到让我难过。", content: "用户因伴侣晚到而感到难过。" },
    { source: "让我失落的就是伴侣晚到这件事。", content: causeNote },
  ])("自然表达明确确认因果时保持user_statement：$source", ({ source, content }) => {
    expect(normalizePrivateNotesFidelity([note(content)], notesContext(source)))
      .toEqual([note(content)]);
  });

  it("明确因果笔记仅多一个语法模态‘会’时仍认可来源", () => {
    const content = "类似的电影安排会让用户期待。";
    expect(normalizePrivateNotesFidelity([note(content)], notesContext("类似的电影安排让我期待。")))
      .toEqual([note(content)]);
  });

  it("不把词尾名词‘约会’截成‘约’来授权因果端点", () => {
    expect(() => normalizePrivateNotesFidelity([note("用户因约而期待。")], notesContext("我因为约会而期待。")))
      .toThrow(SourceFidelityError);
  });

  it("本人纠正可提供明确因果来源", () => {
    expect(normalizePrivateNotesFidelity([note(causeNote)], {
      ...notesContext("伴侣晚到了。我感到失落。"),
      ownerCorrections: [{ content: "本人更正：我因伴侣晚到而感到失落。", sourceMessageIds: [sourceId] }],
    })).toEqual([note(causeNote)]);
  });

  it("本人明确否认因果时拒绝，不能降级来保留被否定的理解", () => {
    expect(() => normalizePrivateNotesFidelity([note(causeNote)], notesContext(
      "伴侣晚到了，我感到失落。但我的失落不是因为伴侣晚到。",
    ))).toThrow(SourceFidelityError);
  });

  it("同原语法中的简短否定也不授权肯定因果", () => {
    expect(() => normalizePrivateNotesFidelity([note(causeNote)], notesContext(
      "我不因伴侣晚到而感到失落。",
    ))).toThrow(SourceFidelityError);
  });

  it("本人纠正否认优先于旧的肯定因果", () => {
    expect(() => normalizePrivateNotesFidelity([note(causeNote)], {
      ...notesContext("我因伴侣晚到而感到失落。"),
      ownerCorrections: [{ content: "本人更正：我的失落不是因为伴侣晚到。", sourceMessageIds: [sourceId] }],
    })).toThrow(SourceFidelityError);
  });

  it("本人纠正省略伴侣主语也能否认同一晚到原因", () => {
    expect(() => normalizePrivateNotesFidelity([note(causeNote)], {
      ...notesContext("我因伴侣晚到而感到失落。"),
      ownerCorrections: [{ content: "我的失落不是因为晚到。", sourceMessageIds: [sourceId] }],
    })).toThrow(SourceFidelityError);
  });

  it.each([
    "我的失落有一点是因为伴侣晚到。",
    "我因伴侣晚到而感到失落，但这不是全部原因。",
  ])("部分原因不能授权全部归因：%s", source => {
    expect(() => normalizePrivateNotesFidelity([
      note("用户的失落全部因为伴侣晚到。"),
    ], notesContext(source))).toThrow(SourceFidelityError);
  });

  it.each([
    "我感到失落，但还没说明发生了什么。",
    "伴侣晚到了，但我没有说明当时的感受。",
    "伴侣没有晚到。我感到失落。",
    "伴侣晚到了。我并没有感到失落。",
  ])("因果任一端无明确肯定来源时拒绝：%s", content => {
    expect(() => normalizePrivateNotesFidelity([note(causeNote)], notesContext(content)))
      .toThrow(SourceFidelityError);
  });

  it("预先标成暂定理解不能救活缺少端点来源的因果", () => {
    expect(() => normalizePrivateNotesFidelity([
      note(causeNote, "tentative_understanding"),
    ], notesContext("我感到失落，但还没有说明原因或事件。")))
      .toThrow(SourceFidelityError);
  });

  it("条件式设想不授权存成当前因果理解", () => {
    expect(() => normalizePrivateNotesFidelity([note(causeNote)], notesContext(
      "如果伴侣晚到，我可能会感到失落。这只是设想，不是已经发生的事。",
    ))).toThrow(SourceFidelityError);
  });

  it("仅更正同一迟到时长且其他事实不变时保留已明确的因果", () => {
    const content = "用户因伴侣晚到十分钟而失落。";
    const raw = [note(content, "user_statement", [sourceId, numericCorrectionId])];
    expect(normalizePrivateNotesFidelity(raw, correctedNotesContext(
      "我因为伴侣晚到二十分钟而失落。",
      "更正一下：晚到十分钟，其他事实不变。",
    ))).toEqual(raw);
  });

  it("漏掉数值更正消息的来源ID时拒绝，不能借未引用消息授权新值", () => {
    expect(() => normalizePrivateNotesFidelity([
      note("用户因伴侣晚到十分钟而失落。", "user_statement", [sourceId]),
    ], correctedNotesContext(
      "我因为伴侣晚到二十分钟而失落。",
      "更正一下：晚到十分钟，其他事实不变。",
    ))).toThrow(SourceFidelityError);
  });

  it.each([
    {
      label: "迟到时长",
      before: "我因为伴侣晚到二十分钟而失落。",
      after: "更正一下：晚到十分钟，其他事实不变。",
      content: "用户因伴侣晚到二十分钟而失落。",
    },
    {
      label: "排队时长",
      before: "我因为排队两小时而疲惫。",
      after: "更正一下：排队一小时，其他事实不变。",
      content: "用户因排队两小时而疲惫。",
    },
  ])("仅引用旧来源时旧数值因果笔记也不能复活：$label", ({ before, after, content }) => {
    expect(() => normalizePrivateNotesFidelity([
      note(content, "user_statement", [sourceId]),
    ], correctedNotesContext(before, after))).toThrow(SourceFidelityError);
  });

  it("排队新时长同时引用原话与更正消息时保留明确因果", () => {
    const content = "用户因排队一小时而疲惫。";
    const raw = [note(content, "user_statement", [sourceId, numericCorrectionId])];
    expect(normalizePrivateNotesFidelity(raw, correctedNotesContext(
      "我因为排队两小时而疲惫。",
      "更正一下：排队一小时，其他事实不变。",
    ))).toEqual(raw);
  });

  it("即使引用了原话与更正消息，也拒绝已被替换的旧数值", () => {
    expect(() => normalizePrivateNotesFidelity([
      note("用户因伴侣晚到二十分钟而失落。", "user_statement", [sourceId, numericCorrectionId]),
    ], correctedNotesContext(
      "我因为伴侣晚到二十分钟而失落。",
      "更正一下：晚到十分钟，其他事实不变。",
    ))).toThrow(SourceFidelityError);
  });

  it("非迟到事件的单一数字更正也保留已明确的因果", () => {
    const content = "用户因连续加班三天而疲惫。";
    const raw = [note(content, "user_statement", [sourceId, numericCorrectionId])];
    expect(normalizePrivateNotesFidelity(raw, correctedNotesContext(
      "我因为连续加班五天而疲惫。",
      "更正一下：连续加班三天，其他事实不变。",
    ))).toEqual(raw);
  });

  it("多个数字同时更正不能继承肯定因果，只能拒绝或明确暂定", () => {
    const content = "用户因每天加班一小时共三天而疲惫。";
    const sourceMessageIds = [sourceId, numericCorrectionId];
    let result: ReturnType<typeof normalizePrivateNotesFidelity>;
    try {
      result = normalizePrivateNotesFidelity([note(content, "user_statement", sourceMessageIds)], correctedNotesContext(
        "我因为每天加班两小时共五天而疲惫。",
        "更正一下：每天加班一小时共三天，其他事实不变。",
      ));
    } catch (error) {
      expect(error).toBeInstanceOf(SourceFidelityError);
      return;
    }
    expect(result).toEqual([note(tentativePrefix + content, "tentative_understanding", sourceMessageIds)]);
  });

  it("数字更正同时否认因果时拒绝，不能借其他事实不变继承原因", () => {
    expect(() => normalizePrivateNotesFidelity([
      note("用户因伴侣晚到十分钟而失落。", "user_statement", [sourceId, numericCorrectionId]),
    ], correctedNotesContext(
      "我因为伴侣晚到二十分钟而失落。",
      "更正一下：伴侣晚到十分钟，其他事实不变。但我的失落不是因为伴侣晚到十分钟。",
    ))).toThrow(SourceFidelityError);
  });
});
