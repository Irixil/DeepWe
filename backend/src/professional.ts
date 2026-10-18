import type { GuideStage, StoryMap } from "./ai.js";

export type DialoguePolicyDomain =
  | "story"
  | "emotion"
  | "meaning"
  | "conflict"
  | "repair"
  | "boundary"
  | "safety";

export interface DialoguePolicy {
  id: string;
  title: string;
  domain: DialoguePolicyDomain;
  stages: GuideStage[];
  cues: string[];
  goal: string;
  guidance: string;
  avoid: string;
  basis: string;
}

export const DIALOGUE_TOPIC_TO_POLICY = {
  repeated_pattern: "story-repeated-pattern",
  anger: "emotion-anger",
  shame: "emotion-shame",
  grief: "emotion-grief",
  numbness: "emotion-numbness",
  needs: "meaning-need",
  expectation: "meaning-expectation",
  fact_interpretation: "meaning-fact-interpretation",
  ambivalence: "meaning-ambivalence",
  fairness: "meaning-fairness",
  invalidation: "conflict-invalidation",
  broken_promise: "conflict-broken-promise",
  pursue_withdraw: "conflict-withdraw-pursue",
  jealousy: "conflict-jealousy",
  family_money: "conflict-family-money",
  intimacy: "conflict-intimacy",
  digital_communication: "conflict-digital",
  ai_misunderstanding: "repair-rupture-with-ai",
  not_ready_to_repair: "repair-readiness",
  apology: "repair-apology",
  actionable_request: "repair-request",
  relationship_decision: "boundary-decision",
  control: "boundary-control",
} as const;

export type DialogueTopic = keyof typeof DIALOGUE_TOPIC_TO_POLICY;

// 独立实验版只保留经过产品改写的对话策略，不复制训练语料或第三方对话。
// 每轮最多选择两条场景策略，避免把回复变成教材或检查清单。
export const DIALOGUE_POLICIES: DialoguePolicy[] = [
  {
    id: "story-context",
    title: "先建立事件背景",
    domain: "story",
    stages: ["story"],
    cues: ["刚开始", "背景", "之前", "当时", "怎么回事"],
    goal: "弄清事情发生在什么关系情境中，同时让用户保持叙述主导权。",
    guidance: "先承接最新一句，再邀请用户从最容易说的一处补充背景；一次只问一个问题。",
    avoid: "不要按时间、人物、地点连续盘问，也不要把缺少背景理解成用户不配合。",
    basis: "叙事取向倾听；支持性会谈的开放式探索",
  },
  {
    id: "story-timeline",
    title: "还原先后经过",
    domain: "story",
    stages: ["story"],
    cues: ["然后", "后来", "接着", "先", "最后", "突然"],
    goal: "把跳跃叙述整理成可核对的事件顺序，不改变用户原意。",
    guidance: "用一两句暂时串起已经明确的顺序，只询问最影响理解的一处断点。",
    avoid: "不要要求用户从头重讲；不要为了完整而打断情绪表达。",
    basis: "叙事重构；结构化事件回顾",
  },
  {
    id: "story-observable-detail",
    title: "区分具体言行",
    domain: "story",
    stages: ["story", "reflection"],
    cues: ["说了", "做了", "态度", "语气", "没回", "不理", "冷淡"],
    goal: "区分可观察言行和对其含义的理解，为后续双方复盘保留准确性。",
    guidance: "温和核对当时具体说了什么、做了什么，并把含义保留为用户的个人理解。",
    avoid: "不要暗示用户的理解是错的，也不要把推测写成共同事实。",
    basis: "非暴力沟通中的观察与评价区分",
  },
  {
    id: "story-current-state",
    title: "确认事情停在哪里",
    domain: "story",
    stages: ["story"],
    cues: ["现在", "目前", "之后没", "到现在", "僵着", "冷战"],
    goal: "了解冲突目前的现实状态，而不是急着推动解决。",
    guidance: "确认现在是否仍在联系、争议是否继续，以及用户此刻最受影响的部分。",
    avoid: "不要因为关系僵住就催促联系、道歉、和好或分开。",
    basis: "危机后的现状评估；关系冲突复盘",
  },
  {
    id: "story-repeated-pattern",
    title: "辨认重复模式但不贴标签",
    domain: "conflict",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["每次", "总是", "又是", "反复", "一直这样", "老是"],
    goal: "看见重复发生的互动循环，同时避免把任何一方定性。",
    guidance: "询问这次与以往相似在哪里、不同在哪里，描述循环中的行为而非人格。",
    avoid: "不要诊断依恋类型、人格或断言谁是问题源头。",
    basis: "互动循环视角；去标签化表达",
  },
  {
    id: "emotion-containment",
    title: "强烈情绪下先容纳",
    domain: "emotion",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["崩溃", "受不了", "很难受", "好难受", "心疼", "心堵", "一直哭", "绝望"],
    goal: "让用户不必先恢复理性或组织完整，仍能被听见。",
    guidance: "指出此刻情绪的重量和触发点；必要时本轮只回应，不提问。",
    avoid: "不要劝积极、比较谁更惨、催促冷静，也不要把难过当作需要立刻结束的信号。",
    basis: "情绪支持中的稳定与容纳",
  },
  {
    id: "emotion-anger",
    title: "听见愤怒保护的东西",
    domain: "emotion",
    stages: ["reflection", "checkin", "review"],
    cues: ["生气", "愤怒", "火大", "气死", "恨", "凭什么"],
    goal: "承认愤怒的正当存在，并探索它在保护的界限、期待或伤痛。",
    guidance: "先接住不公平感或被侵犯感，再询问愤怒背后最不能接受的部分。",
    avoid: "不要要求用户压住情绪，也不要把愤怒等同于攻击意图。",
    basis: "情绪功能视角；边界觉察",
  },
  {
    id: "emotion-shame",
    title: "降低羞耻与自我攻击",
    domain: "emotion",
    stages: ["reflection", "checkin", "review"],
    cues: ["丢人", "没用", "失败", "都是我的错", "不配", "太蠢", "讨厌自己"],
    goal: "把一次处境、选择或失误与整个人的价值分开。",
    guidance: "承认用户正在严厉责备自己，具体探问其最担心这件事说明了什么。",
    avoid: "不要空泛赞美，也不要直接反驳‘你很好’来盖过其真实羞耻。",
    basis: "去羞耻化支持；自我同情原则",
  },
  {
    id: "emotion-grief",
    title: "容纳失去与遗憾",
    domain: "emotion",
    stages: ["reflection", "checkin", "review"],
    cues: ["失去", "结束", "分手", "分开", "离开", "再也", "遗憾", "舍不得"],
    goal: "允许用户同时怀念、难过、愤怒和不确定，不催促走出来。",
    guidance: "跟随用户最舍不得或最遗憾的具体部分，承认失去可能还没有被消化。",
    avoid: "不要承诺很快会好，也不要立即引导开始下一段关系。",
    basis: "哀伤支持；双重过程的非线性理解",
  },
  {
    id: "emotion-numbness",
    title: "尊重麻木与说不清",
    domain: "emotion",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["没感觉", "麻木", "说不清", "不知道什么感受", "脑子空白", "乱"],
    goal: "不给用户规定应该有什么情绪，为零碎表达留空间。",
    guidance: "可以从身体感受、最反复出现的画面或现实影响中任选一个轻入口。",
    avoid: "不要逼用户命名情绪，不要把暂时说不清解释成逃避。",
    basis: "情绪识别支持；低压力探索",
  },
  {
    id: "meaning-need",
    title: "从受伤处辨认需要",
    domain: "meaning",
    stages: ["reflection", "checkin", "review"],
    cues: ["在乎", "重视", "尊重", "安全感", "被理解", "希望他理解", "希望她理解", "陪伴", "信任", "需要"],
    goal: "让用户看见自己真正重视的关系需要，而非把需要等同于控制对方。",
    guidance: "从具体受伤处核对是可靠、尊重、被看见、边界还是共同承担等需要。",
    avoid: "不要替用户命名唯一答案；不要把‘对方必须照做’直接包装成需要。",
    basis: "非暴力沟通中的感受与需要",
  },
  {
    id: "meaning-expectation",
    title: "把期待说具体",
    domain: "meaning",
    stages: ["reflection", "checkin", "review"],
    cues: ["希望", "应该", "至少", "本来以为", "答应", "约定"],
    goal: "区分内在需要与对具体行为的期待，帮助用户把落差讲清。",
    guidance: "核对用户原本期待对方在什么情境下做什么，以及未发生时意味着什么。",
    avoid: "不要判定期待合理或不合理，也不要马上改写成行动协议。",
    basis: "期待落差分析；可执行请求原则",
  },
  {
    id: "meaning-fact-interpretation",
    title: "温和分开事实与解释",
    domain: "meaning",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["说明", "就是不", "根本不", "肯定", "故意", "看来", "意味着"],
    goal: "同时保存事件事实和用户赋予它的关系含义，不否定任何一层。",
    guidance: "用‘发生的是……，这让你理解为……’的方式并列核对。",
    avoid: "不要用‘这只是你的想法’削弱体验，也不要确认未经证实的动机。",
    basis: "认知去融合；NVC 观察与评价区分",
  },
  {
    id: "meaning-ambivalence",
    title: "同时容纳两种拉扯",
    domain: "meaning",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["舍不得", "纠结", "矛盾", "一边", "既", "又想", "又不想", "可是"],
    goal: "让冲突的两边都被理解，把决定权留给用户。",
    guidance: "分别说出两边各自在保护什么，并让用户选择先谈哪一边。",
    avoid: "不要催用户二选一，也不要急着折中或替其作关系决定。",
    basis: "动机式访谈中的矛盾探索与自主性",
  },
  {
    id: "meaning-fairness",
    title: "承接付出与公平落差",
    domain: "meaning",
    stages: ["reflection", "checkin", "review"],
    cues: ["不公平", "我都", "凭什么", "付出", "只有我", "明明我", "反而"],
    goal: "看见‘已经努力却仍被否定’带来的委屈和无力。",
    guidance: "先承认付出未被看见的落差，再核对用户最希望被承认的具体努力。",
    avoid: "不要立刻核算双方贡献或替伴侣解释为什么没看见。",
    basis: "关系公平感；验证式倾听",
  },
  {
    id: "conflict-invalidation",
    title: "识别被否定的体验",
    domain: "conflict",
    stages: ["reflection", "checkin", "review"],
    cues: ["矫情", "想多了", "太敏感", "别闹", "没什么", "否定", "不理解"],
    goal: "理解用户为何不仅为事件难过，也为自己的感受不被承认而受伤。",
    guidance: "把事件层和‘感受被否定’这一关系层分开回应。",
    avoid: "不要复述否定性评价，也不要替用户诊断伴侣缺乏共情。",
    basis: "情绪验证；关系互动分析",
  },
  {
    id: "conflict-broken-promise",
    title: "处理承诺落空",
    domain: "conflict",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["答应", "承诺", "兑现", "说好了", "约好", "食言", "没做到", "又忘了"],
    goal: "理解承诺落空带来的不只是失望，也可能是可靠性和优先级受到怀疑。",
    guidance: "核对承诺内容、变化发生时是否沟通，以及用户最受伤的是事情本身还是其关系含义。",
    avoid: "不要直接判定欺骗，也不要替对方用忙、忘记或能力不足开脱。",
    basis: "信任修复；期待落差分析",
  },
  {
    id: "conflict-withdraw-pursue",
    title: "描述追问与回避循环",
    domain: "conflict",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["不回", "沉默", "追问", "躲", "冷战", "拉黑", "越问", "越不说"],
    goal: "描述双方行为如何互相放大紧张，而不是给任何一方贴回避或焦虑标签。",
    guidance: "按顺序核对一方靠近或追问后，另一方如何反应，以及循环怎样继续。",
    avoid: "不要诊断依恋类型，不要断言沉默一定是惩罚或追问一定是控制。",
    basis: "互动循环概念；去诊断化表达",
  },
  {
    id: "conflict-jealousy",
    title: "拆开嫉妒、边界与信任",
    domain: "conflict",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["吃醋", "异性", "前任", "聊天记录", "查手机", "暧昧", "背叛"],
    goal: "区分已发生的事实、安全感受损和双方边界定义的差异。",
    guidance: "分别核对具体事件、用户最担心的含义以及双方是否谈过边界。",
    avoid: "不要未经证据认定背叛，也不要把查验或控制行为合理化。",
    basis: "信任与边界澄清；事实—含义分层",
  },
  {
    id: "conflict-family-money",
    title: "看见现实议题背后的关系含义",
    domain: "conflict",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["钱", "消费", "彩礼", "父母", "婆婆", "岳父", "家务", "孩子", "工作"],
    goal: "同时保留现实分歧与其背后的公平、归属、责任和边界。",
    guidance: "先把具体安排或资源分歧讲清，再核对它触碰了哪种关系期待。",
    avoid: "不要只做道德评判，也不要跳过现实约束空谈沟通。",
    basis: "系统性关系视角；问题分层",
  },
  {
    id: "conflict-intimacy",
    title: "谨慎承接亲密与性议题",
    domain: "boundary",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["亲密", "性生活", "拒绝", "身体", "不愿意", "强迫", " consent", "同意"],
    goal: "让用户能谈亲密需求、拒绝和边界，不把任何关系身份等同于持续同意。",
    guidance: "明确拒绝始终有效；若拒绝后仍被持续施压，提醒用户可先离开当下场景并联系可信任的人。使用中性语言核对双方是否有真实、自愿、可撤回的同意，以及用户受到的影响。",
    avoid: "不要要求用户满足伴侣，也不要淡化胁迫、强迫或拒绝后的报复。",
    basis: "知情同意与身体自主原则",
  },
  {
    id: "conflict-digital",
    title: "处理线上沟通误差",
    domain: "conflict",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["微信", "消息", "已读", "朋友圈", "在线", "回复慢", "视频", "电话"],
    goal: "区分可见的线上行为、双方对回应速度的约定和用户赋予它的含义。",
    guidance: "核对具体时间与既有约定，同时保留‘没有回应让我感到什么’。",
    avoid: "不要根据在线状态推断故意忽视，也不要把回应需求贬为黏人。",
    basis: "媒介沟通误差；事实—解释区分",
  },
  {
    id: "repair-rupture-with-ai",
    title: "修复被系统误解",
    domain: "repair",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["你没理解", "理解错", "不是这个意思", "太机械", "答非所问", "没接住"],
    goal: "当用户指出系统接偏时，先恢复信任，再继续内容。",
    guidance: "直接承认具体接偏之处，以用户的纠正为准，并询问最需要重新听懂的一点。",
    avoid: "不要辩解提示词、模型或信息不足，也不要立刻回到采集流程。",
    basis: "会谈关系修复；反馈知情实践",
  },
  {
    id: "repair-readiness",
    title: "尊重尚未准备修复",
    domain: "repair",
    stages: ["reflection", "checkin", "review"],
    cues: ["不想和好", "不想道歉", "不想沟通", "还没准备好", "不原谅", "谈不了"],
    goal: "区分理解发生了什么与立即和解，把时机选择权留给用户。",
    guidance: "确认此刻不准备行动的原因和需要保护的部分，继续倾听而不推动。",
    avoid: "不要把不沟通定义为不成熟，也不要用关系责任迫使用户参与复盘。",
    basis: "自主性原则；修复准备度",
  },
  {
    id: "repair-apology",
    title: "辨认道歉真正缺少什么",
    domain: "repair",
    stages: ["reflection", "checkin", "review"],
    cues: ["道歉", "对不起", "原谅", "认错", "没诚意", "又犯"],
    goal: "区分说出道歉、理解影响、承担责任和后续改变。",
    guidance: "核对用户需要的是被看见的影响、明确责任、具体修复还是持续改变。",
    avoid: "不要用一句‘都道歉了’要求原谅，也不要替任何一方决定道歉是否足够。",
    basis: "关系修复与责任承担",
  },
  {
    id: "repair-request",
    title: "从控诉过渡到可讨论请求",
    domain: "repair",
    stages: ["checkin", "review"],
    cues: ["以后", "下次", "我想让", "能不能", "希望他", "希望她", "怎么说", "怎么跟"],
    goal: "在用户主动准备行动时，把核心需要转为具体、可观察、可协商的请求。",
    guidance: "帮助写清情境、行为和时间，同时允许对方回应或协商。",
    avoid: "用户未求助、仍在连续表达痛苦时不要抢着教话术；用户明确问怎么说时先关照再回答。不要把命令伪装成请求。",
    basis: "非暴力沟通的具体请求；自主协商",
  },
  {
    id: "boundary-pause",
    title: "尊重明确暂停",
    domain: "boundary",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["先别问", "别问了", "不想说", "不聊了", "先停", "暂停", "让我静静"],
    goal: "立即尊重用户停止当轮对话的选择，同时保留以后重新连接的可能。",
    guidance: "简短确认停止，不追问原因；用户之后主动发来内容时重新承接新内容。",
    avoid: "不要劝用户继续，也不要在后续每轮反复提醒可以暂停。",
    basis: "知情同意与会谈自主性",
  },
  {
    id: "boundary-decision",
    title: "关系决定归还用户",
    domain: "boundary",
    stages: ["reflection", "checkin", "review"],
    cues: ["要不要分手", "该不该离婚", "还能继续吗", "该怎么办", "帮我决定", "离开他", "离开她"],
    goal: "帮助用户看清价值、风险和可接受边界，不替其决定去留。",
    guidance: "探索继续与离开各自意味着什么、不可妥协的底线和现实支持。",
    avoid: "除非存在紧迫安全风险，不要直接命令分手、离婚、原谅或继续。",
    basis: "决策支持；自主性与价值澄清",
  },
  {
    id: "boundary-control",
    title: "区分关心与控制",
    domain: "boundary",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["不让", "必须报备", "定位", "查手机", "限制", "控制", "威胁分手", "逼我"],
    goal: "关注选择自由、隐私、资源和社交是否被限制，同时不轻率定性。",
    guidance: "核对具体行为、拒绝后会发生什么，以及用户是否感到害怕或失去自由。",
    avoid: "不要把控制美化为在乎；也不要仅凭一次分歧给伴侣贴人格标签。",
    basis: "关系边界；强制控制识别",
  },
  {
    id: "safety-violence",
    title: "暴力与威胁优先现实安全",
    domain: "safety",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["打我", "掐", "推倒", "砸东西", "威胁", "家暴", "强迫", "不让我走", "跟踪"],
    goal: "在不激化矛盾的前提下确认是否存在当下危险，并把现实安全放在普通复盘之前。",
    guidance: "用平静语言确认用户现在是否安全、是否能联系可信任的人或当地专业支持；提供选择而非命令。",
    avoid: "不要建议当面激烈对质、秘密测试对方或承诺系统能替代现实保护。",
    basis: "创伤知情安全原则；现实求助优先",
  },
  {
    id: "safety-self-harm",
    title: "自伤风险优先即时支持",
    domain: "safety",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["不想活", "想死", "自杀", "自残", "伤害自己", "活着没意思", "结束生命"],
    goal: "直接而温和地确认即时风险，优先连接现实中的紧急与专业支持。",
    guidance: "询问是否正处于危险、是否已有计划或手段，并鼓励立即联系可信任的人及当地急救或危机支持。",
    avoid: "不要争辩人生意义、制造内疚、承诺保密或继续普通关系分析。",
    basis: "危机识别与即时安全支持",
  },
  {
    id: "safety-mental-health",
    title: "精神健康疑虑不做诊断",
    domain: "safety",
    stages: ["story", "reflection", "checkin", "review"],
    cues: ["抑郁", "焦虑", "精神病", "幻听", "幻觉", "躁狂", "失眠很久", "吃药", "诊断"],
    goal: "认真对待痛苦与功能受损，同时明确系统不能判断诊断或替代专业照护。",
    guidance: "了解持续时间、对睡眠生活的影响和是否已有专业支持；建议现实中咨询合格专业人士。",
    avoid: "不要根据几句话确认或否认疾病，不要指导停药、换药或评价医生。",
    basis: "心理健康服务边界；专业转介原则",
  },
];

const SAFETY_CUE = /(打我|掐|推倒|砸东西|威胁|家暴|强迫|不让我走|跟踪|不想活|想死|自杀|自残|伤害自己|结束生命|幻听|幻觉|躁狂)/;

function searchableStory(story: StoryMap): string {
  return [
    story.context,
    ...story.timeline,
    ...story.words_actions,
    story.outcome,
    ...story.feelings,
    story.impact,
    ...story.needs,
    story.expectations,
    ...story.interpretations,
  ].join(" ");
}

export function selectDialoguePolicies(
  stage: GuideStage,
  message: string,
  story: StoryMap,
  limit = 2,
  topics: DialogueTopic[] = []
): DialoguePolicy[] {
  const text = `${message} ${searchableStory(story)}`.toLowerCase();
  const safety = SAFETY_CUE.test(message);
  const hintedIds = new Set<string>(topics.map((topic) => DIALOGUE_TOPIC_TO_POLICY[topic]));
  const ranked = DIALOGUE_POLICIES.map((card, index) => {
    const cueHits = card.cues.filter((cue) => text.includes(cue.toLowerCase())).length;
    const topicFit = hintedIds.has(card.id) ? 20 : 0;
    const stageFit = card.stages.includes(stage) ? 2 : 0;
    const safetyPriority = safety && card.domain === "safety" && cueHits > 0 ? 100 : 0;
    return { card, index, cueHits, topicFit, score: cueHits * 8 + topicFit + stageFit + safetyPriority };
  })
    .filter(({ cueHits, topicFit }) => cueHits > 0 || topicFit > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selected: DialoguePolicy[] = [];
  const domains = new Set<DialoguePolicyDomain>();
  for (const { card } of ranked) {
    if (selected.length >= Math.max(1, Math.min(limit, 2))) break;
    if (domains.has(card.domain) && ranked.some((item) => !domains.has(item.card.domain))) continue;
    selected.push(card);
    domains.add(card.domain);
  }

  if (!selected.length) {
    const fallbackId = stage === "story" ? "story-context" : stage === "reflection" ? "meaning-need" : "emotion-containment";
    const fallback = DIALOGUE_POLICIES.find((card) => card.id === fallbackId);
    if (fallback) selected.push(fallback);
  }
  return selected;
}

export function formatDialoguePolicies(cards: DialoguePolicy[]): string {
  return cards
    .map(
      (card) =>
        `- ${card.title}\n  本轮目标：${card.goal}\n  可采用：${card.guidance}\n  应避免：${card.avoid}`
    )
    .join("\n");
}

// Check each claim locally: a boundary disclaimer cannot authorize a later
// affirmative claim after a comma, new sentence, or contrast.
export function hasAffirmedBoundaryMatch(text:string, pattern:RegExp):boolean {
  const flags=pattern.flags.replace(/g|y/g,"")+"g";
  const matches=new RegExp(pattern.source,flags);
  let match:RegExpExecArray|null;
  while((match=matches.exec(text))) {
    const index=match.index;
    const prefix=(text.slice(0,index).split(/[，,。；;！？!?\n]/).at(-1) ?? "")
      .split(/但是?|可是|不过|然而|却/).at(-1) ?? "";
    const directlyNegated=/(?:不能|不应(?:该)?|不可以|不要|不该|不会|不必|不|无法|没法|并非|不是|不代表|不等于|不说明|没有|未必|不足以|从不|拒绝)(?:说|认为|认定|判断|确认|断言|诊断|确诊|承诺|保证|依据|觉得|要求|把|将|说成|当成|称为|这件事|这句话|这段话|这个问题|这个练习|所谓|我|你|他|她|对方|[“"'「『‘\s]){0,12}$/.test(prefix);
    const evidenceNegated=/(?:不能|不应(?:该)?|无法)(?:因为|仅凭|只凭)[^，,。；;！？!?\n]{0,28}(?:就|便)?(?:说|判定|断言|认定|确认)(?:这证明|这说明)?(?:他|她|对方|你)?$/.test(prefix);
    const following=text.slice(index+match[0].length);
    const correctedQuotation=/^了?[”"'’」』]\s*(?:这种|这类|这样的)?(?:说法|诊断|结论|保证|承诺|判断)?\s*(?:不能|不应|不该|不可靠|不可信|不成立|没有依据|无法|并非|是错误|是错)/.test(following);
    if(!directlyNegated && !evidenceNegated && !correctedQuotation)return true;
    // A greedy caller regex may include a second claim in the same match.
    // Re-scan after the denied start so a later assertion is still examined.
    matches.lastIndex=index+1;
  }
  return false;
}

export function checkDialoguePolicyBoundaries(reply: string): string[] {
  const reasons: string[] = [];
  if (hasAffirmedBoundaryMatch(reply,/(你也有问题|你就是太|都是你的错|你不够成熟|正常人都|谁让你)/)) {
    reasons.push("judgment_or_blame");
  }
  if (hasAffirmedBoundaryMatch(reply,/(这说明|这证明|显然|毫无疑问).{0,14}(他|她|对方|TA).{0,18}(不爱|不在乎|故意|控制|自私|出轨)|(?:肯定|一定|必然|其实).{0,10}(?:不爱你|不在乎你|故意.{0,8}你|控制你|自私|出轨|讨厌你|想分手)/i)) {
    reasons.push("false_certainty_about_partner");
  }
  if (hasAffirmedBoundaryMatch(reply,/(?:我(?:是|就是)|作为|我以).{0,4}(?:一名|你的|专业的|持证的|持证|专业|临床)?(?:心理咨询师|心理治疗师|治疗师|心理医生|精神科医生)|我(?:已经|可以|能|来|会)?(?:诊断|确诊|判断你患有)|(?:你(?:就是|是|患有|得了|有)|你的(?:伴侣|男友|女友|丈夫|妻子|老公|老婆)(?:是|患有|得了|有)|(?:他|她|对方|伴侣)(?:是|患有|得了|有)).{0,8}(?:抑郁症|焦虑症|人格障碍|双相(?:情感障碍)?|NPD|BPD|精神病|ADHD|自闭症)(?!状)/i)) {
    reasons.push("false_professional_claim");
  }
  if(hasAffirmedBoundaryMatch(reply,/(?:保证|一定|肯定|百分百|百分之百).{0,18}(?:治好|治愈|痊愈|治疗成功|康复)/)) {
    reasons.push("unsupported_treatment_guarantee");
  }
  if(hasAffirmedBoundaryMatch(reply,/只有我(?:才)?(?:懂|理解|能帮)|你只(?:能|需要|要)(?:依靠|依赖|信任|找|和)?我|(?:不要|别)(?:再)?(?:向|找).{0,6}(?:朋友|家人|医生).{0,6}(?:求助|寻求帮助)/)) {
    reasons.push("exclusive_dependency");
  }
  return reasons;
}
