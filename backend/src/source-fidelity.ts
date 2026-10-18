// Local checks for two observed failures; deliberately not general entailment.
export interface FidelitySource { id: string; content: string; version: number; }
export interface FidelityCorrection { content: string; sourceMessageIds: string[]; }
export interface PrivateDraftRange { start: number; end: number; }
export interface KnownMemoryCorrection {
  topic: string; measure: "迟到" | "等待" | "等候" | "等"; oldMinutes: number; newMinutes: number;
  sourceConversationId: string; sourceMessageId: string; sourceMessageVersion: number;
}
export interface FidelityNote {
  kind: "user_statement" | "tentative_understanding" | "unknown";
  content: string; sourceMessageIds: string[];
}
export class SourceFidelityError extends Error {
  constructor(readonly reason: string) { super("source fidelity check failed"); this.name = "SourceFidelityError"; }
}

const MOTIVE_CUES = /敷衍|嫌.{0,4}(?:事多|麻烦|烦)|(?:找|拿).{0,4}借口|挡一下|不在乎|不重视|故意|报复|看不起|不爱|厌烦|逃避|怕(?:你|我)?(?:生气|吵|冲突|争吵)/gu;
const PARTNER = /(?:他|她|对方|伴侣)/u;
const NEGATED_OR_CONDITIONAL = /(?:不想(?:直接)?认定|不能|不应|不该|不可|无法|没有依据|不代表|并非|不是|未必|不确定|不知道|如果|假如|倘若|若|即使|哪怕)[^，,]{0,32}$/u;
const USER_CONCERN = /我(?:担心|担忧|怕|顾虑|觉得|认为|怀疑|猜)|我会不会|我想知道|我不确定/u;
const ATTRIBUTION_OR_UNCERTAINTY = /(?:你|我|用户)(?:当时)?(?:担心|担忧|害怕|怕|顾虑|觉得|认为|怀疑|猜)|我在意|(?:可能|也许|或许|未必|不一定|不确定|是否|会不会|是不是)/u;
const PARTNER_REPORT = /(?:他|她|对方|伴侣)(?:自己)?(?:跟我|对我)?(?:说|提到|表示|解释)|原话/u;
const EVENT_TIME = /(?:这次|这回|上次|那次|以前|之前|当时|今天|昨天|昨晚|前天)/u;
const QUOTES = /[“「『‘"'][\s\S]*?[”」』’"']/g;
const QUOTE_PAIRS = /([“「『‘"'])([\s\S]*?)([”」』’"'])/gu;

function isNegatedMotiveConclusionMention(clause: string, cueAt: number): boolean {
  for (const match of clause.matchAll(QUOTE_PAIRS)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (cueAt <= start || cueAt >= end - 1) continue;
    const beforeQuote = clause.slice(Math.max(0, start - 28), start);
    const afterQuote = clause.slice(end);
    return /不(?:替|为)(?:他|她|对方|伴侣)?(?:轻易|直接|随意|贸然)?(?:下|作出|做出)\s*$/u.test(beforeQuote)
      && /^\s*(?:的|这个|该)?(?:结论|判断|定论|认定)/u.test(afterQuote);
  }
  return false;
}

function partnerBeforeCue(prefix: string): boolean {
  const local = prefix.split(/[，,：:]/u).at(-1) ?? "";
  const partners = [...local.matchAll(/他|她|对方|伴侣/gu)];
  const last = partners.at(-1);
  if (last && !/(?:面对|给|对|向|和|跟|让|把|帮)$/u.test(local.slice(0, last.index))) return true;
  if (/^(?:还是|或是|抑或|而是)/u.test(local.trim()) && PARTNER.test(prefix.slice(0, -local.length))) return true;
  return /[“「『‘"']/u.test(local) && PARTNER_REPORT.test(prefix.slice(0, -local.length));
}

function motiveSources(currentUserMessage: string, cue: string): string[] {
  const chunks = currentUserMessage.split(/(?<=[。！？!?；;\n])/u);
  return chunks.filter(chunk => {
    const at = chunk.indexOf(cue);
    if (at < 0) return false;
    const prefix = chunk.slice(0, at);
    if (NEGATED_OR_CONDITIONAL.test(prefix) || !partnerBeforeCue(prefix)) return false;
    if (/(?:更正|纠正|收回|撤回)[^。！？!?；;\n]{0,40}(?:不再|不担心|并非|不是|没有|没再)/u.test(chunk)) return false;
    return true;
  });
}

/** Checks only selected personalized partner-motive clauses against current user words and an explicit same-topic continuation. */
export function assertPrivateMotiveEvidence(reply: string, currentUserMessage: string, priorUserMessages: string[] = []): void {
  const followsPrior = /(?:接着|继续|刚才|之前(?:说|讲|提)|这件事|那个安排)/u.test(currentUserMessage)
    && !/(?:更正|纠正|收回|撤回|其实|不再|并非|不是|没有说|没说|这次|这回|上次|那次|今天|昨天|昨晚|前天|另一(?:次|件|个))/u.test(currentUserMessage);
  const sources = [currentUserMessage, ...(followsPrior && priorUserMessages.length ? [priorUserMessages.at(-1)!] : [])];
  for (const clause of reply.split(/[。！？!?；;\n]/u)) {
    for (const match of clause.matchAll(new RegExp(MOTIVE_CUES.source, "gu"))) {
      const at = match.index ?? 0;
      const prefix = clause.slice(0, at);
      // General advice, user feelings, and conditionals are outside this actor guard.
      if (isNegatedMotiveConclusionMention(clause, at)) continue;
      if (!partnerBeforeCue(prefix) || NEGATED_OR_CONDITIONAL.test(prefix)) continue;
      const found = match[0];
      const cue = ["敷衍", "事多", "麻烦", "借口", "挡一下", "不在乎", "不重视", "故意", "报复", "看不起", "不爱", "厌烦", "逃避", "生气", "冲突", "争吵", "吵"]
        .find(candidate => found.includes(candidate)) ?? found;
      const allEvidence = sources.flatMap(source => motiveSources(source, cue));
      const eventMarkers = sources.flatMap(source => source.match(/(?:这次|这回|上次|那次|以前|之前|当时|今天|昨天|昨晚|前天)/gu) ?? []);
      const outputTime = EVENT_TIME.exec(clause)?.[0];
      const evidence = new Set(eventMarkers).size > 1
        ? allEvidence.filter(source => EVENT_TIME.exec(source)?.[0] === outputTime)
        : allEvidence;
      if (!evidence.length) throw new SourceFidelityError("unsupported_partner_motive");
      if (evidence.some(source => USER_CONCERN.test(source.replace(QUOTES, "").replace(/[“「『‘"'][^”」』’"']*$/u, "")))
        && !ATTRIBUTION_OR_UNCERTAINTY.test(clause)) {
        throw new SourceFidelityError("unsupported_user_concern_attribution");
      }
      if (evidence.some(source => PARTNER_REPORT.test(source))
        && !ATTRIBUTION_OR_UNCERTAINTY.test(clause)
        && !PARTNER_REPORT.test(clause)
        && !/(?:你(?:刚才)?转述|你(?:之前)?说|提供的解释)/u.test(clause)) {
        throw new SourceFidelityError("unbounded_partner_motive");
      }
    }
  }
}

function minuteAlternatives(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  let rest = value, chinese = "";
  if (!Number.isInteger(value) || value <= 0 || value > 999) return String(value);
  if (rest >= 100) { const hundreds = Math.floor(rest / 100); chinese += `${digits[hundreds]}百`; rest %= 100; }
  if (rest >= 10) { const tens = Math.floor(rest / 10); chinese += `${tens === 1 && !chinese ? "" : digits[tens]}十`; rest %= 10; }
  if (rest) chinese += digits[rest]!;
  return `(?:${value}|${chinese})`;
}
function normalizeEventCandidate(value: string): string {
  return value
    .replace(/^(?:再聊|继续聊|聊聊|谈谈|说说|再|又|继续|然后|而且|但是|不过|但|而|我对|本人对|我关于|本人关于|我|本人|我们|你们|你|他|她|他们|对方|伴侣|这次|那次|之前|刚才|上周|周末|昨天|今天|前天|明天|周[一二三四五六日天]|当时|关于|现在|目前|当前|记得|记的|记录|查看|查下|查一下|回忆|想起)+/u, "")
    .replace(/(?:这件事|这件事情|安排|约定|计划|时间|时长|记录|记得|记的|当前|现在|之后|之前|的)+$/u, "")
    .replace(/(?:对方|伴侣|他|她|我|我们|你|你们)+$/u, "");
}
function hasOtherExplicitEventTopic(text: string, topic: string): boolean {
  const suffixes = [
    /([\u3400-\u9fffA-Za-z0-9]{2,10}?)(?:安排|约定)/gu,
    /([\u3400-\u9fffA-Za-z0-9]{2,10}?)(?:那次|那件事)(?:的)?(?:迟到|晚到|等待|等候|等着|等了)/gu,
  ];
  return suffixes.flatMap(pattern => [...text.matchAll(pattern)].map(match => normalizeEventCandidate(match[1]!)))
    .some(candidate => candidate.length >= 2 && !/(?:时间|时长|现在|当前|记得|记的|记录|什么|多少|之前|之后)/u.test(candidate)
      && candidate !== topic && !candidate.includes(topic) && !topic.includes(candidate));
}

const UNCERTAIN = /不记得|不确定|不知道|是否|是不是|可能|也许|或许|假如|如果|倘若/;
const REPORTED = /(?:他|她|对方|伴侣|朋友|你|助手|笔记)(?:上次|之前|刚才)?(?:说|认为|觉得|猜|写)|听说|据说|引用|原话|那句话/;
const TIME = /上个月|这个月|上周|本周|去年|今年|昨天|今天|前天|明天|那天|那晚|那夜|当时|那时|现在|目前/;
const ABSOLUTE_EVENT = /上个月|这个月|上周|本周|去年|今年|昨天|今天|前天|明天|这次|这回|上次|另一次|另一回|周末|周[一二三四五六日天]/gu;
const RELATIVE_EVENT = /那天|那晚|那夜|当时|那时/gu;
const WAIT = /(?:等待|等候|等着|等了|等过|等(?=我|他|她|你|对方|伴侣|回复|回应|消息|[，,。；;！？!?\s]|$))/;

function clauses(text: string): string[] {
  return text.replace(QUOTES, "").split(/(?<=[！？!?])|[，,。；;\n]|但是?|可是|不过|然而|却/).filter(Boolean);
}
function localPrefix(text: string, index: number): string {
  return text.slice(0,index).split(/[，,。；;！？!?\n：:]|但是?|可是|不过|然而|却/).at(-1) ?? "";
}
function uncertainWaiting(text: string, index: number, phrase: string): boolean {
  const prefix=localPrefix(text,index);
  if(/(?:如果|假如|倘若|若|可能|也许|或许|不确定|不知道|不能(?:据此)?(?:说|认定)|不应(?:据此)?(?:说|认定)|不代表|不是|并非|没有|并没有|并未|不曾|从未|从没)[^，,。；;！？!?\n]{0,18}$/.test(prefix)) return true;
  if(UNCERTAIN.test(phrase)||/并没有|没有|不是|并非|从未|没/.test(phrase)) return true;
  const rest=text.slice(index+phrase.length);
  return /^(?:吗|么|？|\?)/.test(rest) || /^[”」』’"'](?:这种|这个|这样的)?(?:说法|理解|前提)?(?:没有依据|不成立|不是事实|不准确|是错|不应)/.test(rest);
}
function ownWaiting(text: string, anchor: string | undefined): boolean {
  return clauses(text).some(clause=>{
    const subject=clause.indexOf("我");
    if(subject<0 || REPORTED.test(clause.slice(0,subject)) || /不是|并非|没有/.test(clause.slice(0,subject))) return false;
    const found=WAIT.exec(clause.slice(subject+1));
    if(!found) return false;
    if(/[吗么？?]/.test(clause.slice(subject+1+found.index+found[0].length))) return false;
    const before=clause.slice(subject+1,subject+1+found.index);
    if(UNCERTAIN.test(before) || /没有|并未|从未|根本没|不是|并非|没|(?:他|她|对方|伴侣|朋友|觉得|认为|听|说|问|希望|想要|打算|准备)/.test(before)) return false;
    if(UNCERTAIN.test(clause.slice(0,subject))) return false;
    const sourceAnchor=TIME.exec(clause)?.[0];
    return !anchor || /当时|那时/.test(anchor) || anchor===sourceAnchor;
  }) || implicitWaitingMentions(text).some(mention => mention.subject === "我" && !mention.conditional && !mention.negated
    && !uncertainWaiting(text, mention.index, mention.phrase)
    && (!anchor || /当时|那时/.test(anchor) || anchor === mention.anchor));
}

function deniesWaiting(text: string, anchor: string | undefined): boolean {
  return clauses(text).some(clause=>{
    const sourceAnchor=TIME.exec(clause)?.[0];
    if(anchor && !/当时|那时/.test(anchor) && sourceAnchor && sourceAnchor!==anchor) return false;
    return /(?:不是|并非)我[^，,。]{0,14}(?:等待|等候|等着|等了|等过|等他|等她|等你|等伴侣|等对方)/.test(clause)
      || /我[^，,。]{0,14}(?:没有|没|并未|从未|根本没|不是)[^，,。]{0,10}(?:等待|等候|等着|等了|等过|等他|等她|等你|等伴侣|等对方|等回复|等回应)/.test(clause);
  }) || implicitWaitingMentions(text).some(mention => mention.subject === "我" && mention.negated && !mention.conditional
    && (!anchor || /当时|那时/.test(anchor) || !mention.anchor || anchor === mention.anchor));
}

interface QuoteSpan { start: number; end: number; depth: number; }
function quoteSpans(text: string): QuoteSpan[] | null {
  const openToClose: Record<string, string> = { "“": "”", "「": "」", "『": "』", "‘": "’", '"': '"', "'": "'" };
  const closeToOpen = new Map(Object.entries(openToClose).map(([open, close]) => [close, open]));
  const stack: Array<{ start: number; open: string; close: string; depth: number }> = [];
  const spans: QuoteSpan[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    const top = stack.at(-1);
    if (top && character === top.close) {
      stack.pop();
      spans.push({ start: top.start, end: index + 1, depth: top.depth });
    } else if (character in openToClose) {
      stack.push({ start: index, open: character, close: openToClose[character]!, depth: stack.length });
    } else if (closeToOpen.has(character)) {
      return null;
    }
  }
  return stack.length ? null : spans.sort((a, b) => a.start - b.start);
}

interface ReplyDraftSpan { start: number; end: number; body: string; sourceOffsets: number[]; kind: "paired" | "markdown"; }
function markdownReplySpans(text: string): ReplyDraftSpan[] {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (const line of text.split("\n")) { lines.push({ text: line, start, end: start + line.length }); start += line.length + 1; }
  const marker = /^ {0,3}> ?/u;
  const spans: ReplyDraftSpan[] = [];
  for (let i = 0; i < lines.length;) {
    const first = marker.exec(lines[i]!.text);
    if (!first) { i++; continue; }
    const lineIndexes: number[] = [];
    let j = i;
    while (j < lines.length) {
      if (marker.exec(lines[j]!.text)) { lineIndexes.push(j++); continue; }
      if (!lines[j]!.text.trim() && j + 1 < lines.length && marker.test(lines[j + 1]!.text)) { lineIndexes.push(j++); continue; }
      break;
    }
    let body = "";
    const sourceOffsets: number[] = [];
    lineIndexes.forEach((lineIndex, bodyLine) => {
      const line = lines[lineIndex]!;
      if (bodyLine) { body += "\n"; sourceOffsets.push(lines[lineIndexes[bodyLine - 1]!]!.end); }
      const prefix = marker.exec(line.text);
      if (prefix?.[0]) {
        const contentStart = line.start + prefix[0].length;
        const content = line.text.slice(prefix[0].length);
        body += content;
        for (let k = 0; k < content.length; k++) sourceOffsets.push(contentStart + k);
      }
    });
    spans.push({ start: lines[i]!.start, end: lines[lineIndexes.at(-1)!]!.end, body, sourceOffsets, kind: "markdown" });
    i = j;
  }
  return spans;
}

// Resolve only comma/conjunction continuations with an explicit same-sentence
// subject. Quotation and structured draft boundaries start a new scope.
function implicitWaitingMentions(text: string, draftRanges: PrivateDraftRange[] = []): Array<{
  subject: string; phrase: string; index: number; anchor?: string; conditional: boolean; negated: boolean;
}> {
  const quotes = quoteSpans(text);
  if (!quotes) return [];
  const mask = text.split("");
  for (const quote of quotes) {
    if (draftRanges.some(range => range.start === quote.start + 1 && range.end === quote.end - 1)) {
      mask[quote.start] = mask[quote.end - 1] = "。";
    } else for (let index = quote.start; index < quote.end; index++) mask[index] = "。";
  }
  const plain = mask.join("");
  const head = new RegExp(`^\\s*(?:(?:${ABSOLUTE_EVENT.source}|${RELATIVE_EVENT.source}|${UNCERTAIN.source})\\s*)*(我|你|用户|他|她|对方|伴侣|朋友|同事|家人)(?!们|的)`, "u");
  const continuation = new RegExp(`^\\s*(?:(?:${TIME.source}|一直|已经|确实|正在|可能|也许|或许|是否|是不是|并没有|没有|并未|不曾|不是|并非|从未|从没|根本没|没|不|再|还|也|又|仍然|仍|继续|在))*${WAIT.source}(?:我|他|她|你|对方|伴侣|回复|回应|消息)?(?:的时候|时)?`, "u");
  const result: ReturnType<typeof implicitWaitingMentions> = [];
  let subject: string | null = null, conditional = false, start = 0, sentenceStart = 0;
  const boundaries = [...plain.matchAll(/[，,。；;！？!?\n：:]|但是?|可是|不过|然而|却|而且/gu), { index: plain.length, 0: "。" }];
  for (const boundary of boundaries) {
    const end = boundary.index!, clause = plain.slice(start, end);
    const explicit = head.exec(clause);
    if (explicit) {
      subject = explicit[1]!;
      conditional = UNCERTAIN.test(clause.slice(0, explicit[0].lastIndexOf(subject)));
      // A second person inside the preceding predicate may be a nested
      // subject. Do not turn its ambiguous continuation into owner evidence.
      const predicate = clause.slice(explicit[0].length);
      const rest = predicate.slice(0, WAIT.exec(predicate)?.index ?? predicate.length);
      try {
        const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(rest)];
        const people = words.filter(token => /^(?:我|你|用户|他|她|对方|伴侣|朋友|同事|家人)$/u.test(token.segment));
        if (people.some(person => person.segment !== subject
          && [subject, person.segment].some(actor => /^(?:我|你|用户)$/u.test(actor ?? ""))
          && rest.slice(person.index + person.segment.length).trim()
          && !/^(?:给|对|向|跟)$/u.test(words.filter(word => word.index < person.index).at(-1)?.segment ?? ""))) subject = "ambiguous";
      } catch { subject = "ambiguous"; }
    } else if (clause.trim()) {
      const omitted = continuation.exec(clause);
      if (subject && omitted) {
        const index = start + omitted.index;
        const times = [...plain.slice(sentenceStart, index + omitted[0].length).matchAll(new RegExp(TIME.source, "gu"))];
        const beforeAction = omitted[0].slice(0, WAIT.exec(omitted[0])?.index ?? 0);
        const negated = /并没有|没有|并未|不曾|不是|并非|从未|从没|根本没|没|不/u.test(beforeAction);
        result.push({ subject, phrase: omitted[0], index, anchor: times.at(-1)?.[0], conditional, negated });
      } else subject = null;
    }
    start = end + boundary[0].length;
    if (/[。；;！？!?\n：:]/u.test(boundary[0])) { subject = null; conditional = false; sentenceStart = start; }
  }
  return result;
}

function replyDraftSpans(text: string): ReplyDraftSpan[] | null {
  const markdown = markdownReplySpans(text);
  const masked = text.split("");
  for (const span of markdown) for (let i = span.start; i < span.end; i++) if (masked[i] !== "\n" && masked[i] !== "\r") masked[i] = " ";
  const quotes = quoteSpans(masked.join(""));
  if (!quotes) return null;
  return [...markdown, ...quotes.filter(span => span.depth === 0 && !markdown.some(block => span.start >= block.start && span.end <= block.end))
    .map(span => ({ start: span.start, end: span.end, body: text.slice(span.start + 1, span.end - 1), sourceOffsets: Array.from({ length: span.end - span.start - 2 }, (_, i) => span.start + 1 + i), kind: "paired" as const }))]
    .sort((a, b) => a.start - b.start);
}

function paragraphBefore(text: string, end: number): string {
  const prefix = text.slice(0, end).replace(/[ \t\n]+$/u, "");
  const breaks = [...prefix.matchAll(/\n[ \t]*\n/gu)];
  const last = breaks.at(-1);
  return prefix.slice(last ? (last.index ?? 0) + last[0].length : 0).trim();
}

function exampleContextIsUserToPartner(text: string): boolean {
  const paired = quoteSpans(text);
  if (!paired) return false;
  let plain = "", last = 0;
  for (const span of paired.filter(item => item.depth === 0)) { plain += text.slice(last, span.start) + " "; last = span.end; }
  plain += text.slice(last);
  plain = plain.replace(/\s+/gu, " ").trim();
  const directOpening = /你(?:可以|能|要|应该|先|直接|主动|不妨|试着)?(?:先)?(?:开口|开场|开头|起头)(?:时|后|来)?/u.exec(plain);
  const selfLedSequence = /(?:开场|开头|起头)[^。！？!?；;]{0,42}(?:先|由你)[^。！？!?；;]{0,8}(?:说|讲|表达|解释|说明)[^。！？!?；;]{0,22}(?:你|自己)/u.exec(plain);
  const opening = directOpening ?? selfLedSequence;
  const handoff = /(?:把话|话题|接下来的话)[^。！？!?；;]{0,28}(?:交给|留给|递给)(?:她|他|对方|伴侣)/u.exec(plain);
  if (!opening || !handoff || Math.abs((handoff.index ?? 0) - (opening.index ?? 0)) > 150) return false;
  const nonaffirmativeOpening = [
    /(?:你|由你)[^，,。！？!?；;]{0,6}(?:不用|不必|不需要|不要|不能|不应|不该|不开|未必|不确定|是否|要不要|会不会|可能|也许)[^，,。！？!?；;]{0,8}(?:开口|开场|开头|起头|说|讲|表达)/u,
    /(?:不用|不必|不需要|不要|不能|不应|不该|未必|不确定|是否|要不要|会不会)[^，,。！？!?；;]{0,8}(?:你|由你)[^，,。！？!?；;]{0,6}(?:开口|开场|开头|起头|说|讲|表达)/u,
    /(?:你|由你)[^，,。！？!?；;]{0,6}(?:不|没|没有|别)(?:会|想|再|先)?(?:开口|开场|开头|起头|说|讲|表达)/u,
    /(?:你|由你)[^，,。！？!?；;]{0,6}别(?:先|再)?(?:开口|开场|开头|起头|说|讲|表达)/u,
    /你[^，,。！？!?；;]{0,6}(?:开口|开场|开头|起头)(?:吗|么|？|\?)/u,
  ].some(pattern => pattern.test(plain));
  const otherSpeakerOpening = [
    /(?:让|请|叫|由|安排|建议|替|帮)(?:她|他|对方|伴侣|朋友|同事|家人|别人|第三人|其他人|小[\p{Script=Han}]{1,2})[^，,。！？!?；;]{0,12}(?:开口|开场|开头|起头|说|讲|表达)/u,
    /(?:她|他|对方|伴侣|朋友|同事|家人|别人|第三人|其他人|小[\p{Script=Han}]{1,2})(?:先|可以|会|要)?(?:开口|开场|开头|起头)/u,
  ].some(pattern => pattern.test(plain));
  if (nonaffirmativeOpening || otherSpeakerOpening) return false;
  let tokens: Intl.Segments;
  try { tokens = new Intl.Segmenter("zh", { granularity: "word" }).segment(plain); }
  catch { return false; }
  const parts = [...tokens];
  const partnerRecipients = new Set(["她", "他", "对方", "伴侣", "对象", "女友", "男友", "妻子", "丈夫", "老婆", "老公"]);
  const otherRecipient = parts.some((token, i) => {
    const recipient = parts[i + 1];
    if (!/(?:对|跟|向|给)$/u.test(token.segment) || !recipient || partnerRecipients.has(recipient.segment)) return false;
    const after = plain.slice(recipient.index + recipient.segment.length);
    return /^[^。！？!?；;]{0,12}(?:发|写|说|讲|告诉|联系|开口|开场|沟通)/u.test(after);
  });
  if (otherRecipient) return false;
  const handoffSentence = plain.slice(plain.lastIndexOf("。", handoff.index) + 1, plain.indexOf("。", handoff.index) < 0 ? undefined : plain.indexOf("。", handoff.index));
  if (/(?:别|不要|不必|不应|不能|不该)[^，,。！？!?；;]{0,14}(?:把话|话题|交给|留给|递给)/u.test(handoffSentence)) return false;
  if (/(?:把话|话题|接下来的话)[^。！？!?；;]{0,28}(?:交给|留给|递给)(?:朋友|同事|家人|别人|第三人|其他人)/u.test(plain)) return false;
  if (/(?:让|请|叫|建议|替|要求|帮)(?:她|他|对方|伴侣|朋友|同事|家人|别人|第三人|其他人)[^，,：:]{0,18}(?:发|写|说|讲|开口|开场|开头)/u.test(plain)) return false;
  if (/(?:她|他|对方|伴侣)(?:本人)?(?:也)?(?:可以|能|应该|先)?(?:这样说|用这段话说)/u.test(plain)) return false;
  return true;
}

function withoutQuotedText(text: string): string {
  const spans = quoteSpans(text);
  if (!spans) return "";
  let output = "", last = 0;
  for (const span of spans.filter(item => item.depth === 0)) {
    output += text.slice(last, span.start) + " ";
    last = span.end;
  }
  return output + text.slice(last);
}

function lastAnchorBefore(text: string, index: number): { anchor: string | null; ambiguous: boolean } {
  const prefix = text.slice(0, index);
  const absolute = [...prefix.matchAll(new RegExp(ABSOLUTE_EVENT.source, "gu"))].map(match => match[0]);
  const values = absolute.length ? absolute : [...prefix.matchAll(new RegExp(RELATIVE_EVENT.source, "gu"))].map(match => match[0]);
  return { anchor: values.at(-1) ?? null, ambiguous: new Set(values).size > 1 };
}

function hasEstablishedEventAlias(text: string, index: number, anchor: string | null, relative: string): boolean {
  if (!anchor || !new RegExp(`^(?:${RELATIVE_EVENT.source})$`, "u").test(relative)) return false;
  const prefix = text.slice(0, index);
  const absolute = [...prefix.matchAll(new RegExp(ABSOLUTE_EVENT.source, "gu"))];
  if (!absolute.length || new Set(absolute.map(match => match[0])).size !== 1 || absolute[0]![0] !== anchor) return false;
  for (const alias of prefix.matchAll(new RegExp(RELATIVE_EVENT.source, "gu"))) {
    if (alias[0] !== relative) continue;
    const event = absolute.filter(match => match.index! < alias.index!).at(-1);
    if (!event || /[。！？!?；;\n]/u.test(prefix.slice(event.index, alias.index))) continue;
    const sentenceStart = prefix.slice(0, event.index).search(/[^。！？!?；;\n]*$/u);
    const sentenceEnd = text.slice(alias.index).search(/[。！？!?；;\n]/u);
    const bindingSentence = text.slice(sentenceStart, sentenceEnd < 0 ? index : alias.index! + sentenceEnd);
    if (UNCERTAIN.test(bindingSentence) || REPORTED.test(bindingSentence) || PARTNER_REPORT.test(bindingSentence)
      || /(?:不是|并非|没说|没有说|未说|更正|纠正|收回|撤回)/u.test(bindingSentence)) continue;
    const continuation = prefix.slice(event.index! + event[0].length);
    const interval = "[零〇一二两三四五六七八九十百千万\\d几数半]+(?:个)?(?:分钟|钟头|小时|星期|天|日|夜|晚|周|月|年)";
    if (new RegExp(`(?:${interval})(?:之后|以后|后)|(?:过了?|隔了?)(?:${interval})`, "u").test(continuation)) continue;
    // A new relative event cannot inherit the earlier date. Neutral 当时/那时
    // can continue the established event across sentence boundaries.
    if (/第[一二三四五六七八九十百\d]+(?:天|晚|夜)|次日|翌日|隔[天日夜]|另(?:一)?[天晚夜次回]|后来|此后|改天|最近|如今|现在|目前/u.test(continuation)) continue;
    if ([...continuation.matchAll(new RegExp(RELATIVE_EVENT.source, "gu"))]
      .some(match => match[0] !== relative && match[0] !== "当时" && match[0] !== "那时")) continue;
    return true;
  }
  return false;
}

function hasAffirmedPartnerWaiting(text: string, draftQuote: { sentence: string; phraseIndex: number }): boolean {
  const unquoted = withoutQuotedText(text);
  if (!unquoted) return false;
  if (typeof Intl.Segmenter !== "function") return false;
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  const replyAnchor = lastAnchorBefore(draftQuote.sentence, draftQuote.phraseIndex);
  const messageAnchor = lastAnchorBefore(unquoted, unquoted.length);
  if (replyAnchor.ambiguous || messageAnchor.ambiguous) return false;
  const mentions: Array<{ affirmative: boolean; anchor: string | null; ambiguous: boolean; waitIndex: number }> = [];
  let sentenceOffset = 0;
  for (const sentence of unquoted.split(/(?<=[。！？!?；;\n])/u)) {
    const clauses = [...sentence.matchAll(/[^，,]+/gu)];
    for (const part of clauses) {
      const clause = part[0];
      for (const wait of clause.matchAll(new RegExp(WAIT.source, "gu"))) {
        const localPrefix = clause.slice(0, wait.index);
        const partner = [...segmenter.segment(localPrefix)].filter(token =>
          /^(?:他|她|对方|伴侣)$/u.test(token.segment)).at(-1);
        if (!partner) continue;
        const prefix = localPrefix.slice(0, partner.index);
        const between = localPrefix.slice(partner.index + partner.segment.length);
        if (!/^(?:(?:自己|当时|那时|现在|目前|也|还|又|一直|已经|正在|就|在))*$/u.test(between)) continue;
        const globalWaitIndex = sentenceOffset + (part.index ?? 0) + (wait.index ?? 0);
        const sourceAnchor = lastAnchorBefore(unquoted, globalWaitIndex);
        const causalVerb = /(?:让|使|害|导致)[^，,。！？!?；;\n]*$/u.exec(prefix);
        const denialScope = causalVerb ? prefix.slice((causalVerb.index ?? 0) + causalVerb[0].length) : prefix;
        const deniedCausalVerb = /(?:不是|并非|没有|没|未|不曾|从未|不)(?:我|本人)?(?:让|使|害|导致)$/u.test(prefix);
        const deniedBeforeSubject = deniedCausalVerb || /(?:不是|并非|没|没有|未|不曾|从未|不确定|不知道|不能|不应|不想(?:说|认定)|不代表|别说|不要说|更正|纠正|收回|撤回|没说|没有说|没提|未提)[^，,。！？!?；;\n]{0,24}$/u.test(denialScope);
        const deniedAfterSubject = /(?:让|使|叫|逼|要求|安排)[^，,。]{0,6}(?:我|你)/u.test(between)
          || /(?:不|没|没有|未|并非|不是|从未|不曾)[^，,。]{0,8}$/u.test(between);
        const afterWait = clause.slice((wait.index ?? 0) + wait[0].length);
        const question = /[？?]\s*$|(?:吗|么)[^，,。！？!?；;\n]*[。！？!?；;\n]?\s*$/u.test(afterWait);
        const reportedOrUncertain = UNCERTAIN.test(prefix) || UNCERTAIN.test(between) || question
          || REPORTED.test(prefix) || PARTNER_REPORT.test(prefix)
          || /(?:他|她|对方|伴侣)(?:告诉我|跟我说|对我说)|我(?:听说|听到)/u.test(prefix)
          || /我[^，,。]{0,8}(?:觉得|认为|怀疑|猜|可能|也许|或许|不确定|不知道|估计)/u.test(prefix);
        const affirmative = !deniedBeforeSubject && !deniedAfterSubject && !reportedOrUncertain;
        mentions.push({ affirmative, ...sourceAnchor, waitIndex: globalWaitIndex });
      }
    }
    sentenceOffset += sentence.length;
  }
  if (mentions.length !== 1 || !mentions[0]!.affirmative || mentions[0]!.ambiguous) return false;
  if (replyAnchor.anchor !== null) return mentions[0]!.anchor === replyAnchor.anchor
    || hasEstablishedEventAlias(unquoted, mentions[0]!.waitIndex, mentions[0]!.anchor, replyAnchor.anchor);
  return mentions[0]!.anchor === messageAnchor.anchor;
}

type DraftQuoteMatch = { kind: "partner"; sentence: string; phraseIndex: number; phraseLength: number } | { kind: "blocked" };

function hasConditionalUserDraftSubject(introduction: string): boolean {
  const comma = introduction.search(/[，,]/u);
  if (comma < 0) return false;
  const condition = introduction.slice(0, comma).trim();
  const mainClause = introduction.slice(comma + 1).replace(/[:：]$/u, "").trim();
  return /^(?:如果|假如)\s*你[^，,。！？!?]{0,20}(?:想|要|打算|准备)(?:发|写|说|讲)[^，,。！？!?]*$/u.test(condition)
    && /^(?:你)?(?:可以|能|不妨)[^。！？!?]{0,28}$/u.test(mainClause);
}

const PARTNER_RECIPIENTS = new Set(["她", "他", "对方", "伴侣", "对象", "女友", "男友", "妻子", "丈夫", "老婆", "老公", "爱人"]);

function hasCompetingRecipientIntent(text: string): boolean {
  return text.split(/[。！？!?；;\n]/u).some(sentence => {
    const intent = /我[^。！？!?；;\n]*?(?:想|打算|准备|要)/u.exec(sentence);
    if (!intent) return false;
    const scope = sentence.slice((intent.index ?? 0) + intent[0].length);
    const recipients = [...scope.matchAll(/(?:给|对|向|跟)([^，,。！？!?；;\n]+?)(?:发|写|说|联系)/gu)];
    if (recipients.some(match => !PARTNER_RECIPIENTS.has(match[1]!.trim()))) return true;
    // A communication intent with an unresolved recipient cannot inherit
    // the partner role from an unrelated waiting statement.
    return !recipients.length && /(?:给|对|向|跟)[^。！？!?；;\n]*(?:发|写|说|联系)|(?:发|写|说|联系)[^。！？!?；;\n]*(?:给|对|向|跟)/u.test(scope);
  });
}

function explicitRequestRecipients(text: string): string[] {
  return [
    ...[...text.matchAll(/(?:给|对|向|跟)([^，,。！？!?；;\n]{1,20}?)(?:发|写|说|讲|联系|解释|说明|沟通)/gu)].map(match => match[1]!),
    ...[...text.matchAll(/(?:发|写|说|讲|联系|解释|说明|沟通)(?:给|对|向|跟)([^，,。！？!?；;\n]{1,24})/gu)].map(match => match[1]!),
  ];
}

function recipientObjectIsPartner(value: string): boolean {
  const heads = [...PARTNER_RECIPIENTS].sort((a, b) => b.length - a.length);
  let tail = value.trim();
  for (;;) {
    const head = heads.find(candidate => tail.startsWith(candidate));
    if (!head) return false;
    tail = tail.slice(head.length);
    if (!/^[\/或]/u.test(tail)) break;
    tail = tail.slice(1);
  }
  if (!tail) return true;
  // A requested utterance is a message tail, not a possessive person (她的同事).
  if (/^的?(?:[一二两三几\d]+(?:句|段|条))?(?:话(?:语)?|消息|文字)$/u.test(tail)) return true;
  // A quantity starts the requested message, not a new addressee: 写给她一段简短的话。
  if (!/^[一二两三几\d]+(?:句|段|条|句话)/u.test(tail)) return false;
  try {
    const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(tail)];
    return !words.some(word => /^(?:给|对|向|跟)$/u.test(word.segment))
      && explicitRequestRecipients(tail).length === 0;
  } catch { return false; }
}

export function ownerToPartnerDraftContextAllowed(currentMessage: string, priorUserMessages: string[] = []): boolean {
  if (/(?:只想倾诉|不想(?:发|写|说|联系)(?:给|对|跟|向)?(?:他|她|对方|伴侣)|不要(?:代写|帮我写|替我写)|别(?:代写|帮我写|替我写))/u.test(currentMessage)) return false;
  const explicitRecipients = explicitRequestRecipients(currentMessage);
  if (explicitRecipients.length) return explicitRecipients.every(recipientObjectIsPartner);
  if (hasCompetingRecipientIntent(currentMessage)) return false;
  // The owner may welcome an optional draft without first asking for one.
  // Require an actual counterpart in their words; P0 alone is not evidence.
  const hasCounterpart = (text: string) => {
    try { return [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)].some(token => PARTNER_RECIPIENTS.has(token.segment)); }
    catch { return false; }
  };
  if (hasCounterpart(currentMessage)) return true;
  const previous = priorUserMessages.at(-1);
  return Boolean(previous && /(?:那就|那|接着|继续|刚才|之前|这件事|那个|按你说的)/u.test(currentMessage)
    && hasCounterpart(previous)
    && (explicitRequestRecipients(previous).length
      ? explicitRequestRecipients(previous).every(recipientObjectIsPartner)
      : !hasCompetingRecipientIntent(previous)));
}

function hasAffirmedKnowledge(text: string): boolean {
  const verbs = /(?:亲眼看到|确定|明白|知道|看见|看到|发现|确认)/gu;
  for (const match of text.matchAll(verbs)) {
    const at = match.index ?? 0;
    const prefix = text.slice(Math.max(0, at - 12), at);
    if (/我[^，,。；;！？!?]{0,8}$/u.test(prefix)
      && !/(?:不|没|未|从未|可能|也许|或许|未必|不太|是否)$/u.test(prefix)) return true;
  }
  return false;
}

function hasSameSentenceKnowledge(body: string, phraseIndex: number): boolean {
  let start = 0, end = body.length;
  for (const mark of body.matchAll(/[。！？!?；;\n]/gu)) {
    const at = mark.index ?? 0;
    if (at < phraseIndex) start = at + mark[0].length;
    else { end = at; break; }
  }
  const sentence = body.slice(start, end);
  const localIndex = phraseIndex - start;
  if (hasAffirmedKnowledge(sentence.slice(0, localIndex))) return true;
  const suffix = sentence.slice(localIndex);
  return /^[^，,。；;！？!?\n]{0,14}[，,]\s*(?:(?:这|这个|这件事|这部分|上述)\s*)?我(?:也|确实)?(?:知道|明白|看见|看到|亲眼看到|发现|确认|确定)/u.test(suffix);
}

function waitingCauseKey(text: string): string {
  return causeKey(text.replace(/没有/gu, "没").replace(/^(?:当时|那时|是|因为|由于)+/u, "").trim());
}

function draftWaitingCause(sentence: string, phraseIndex: number, phraseLength: number): string | null | undefined {
  const before = sentence.slice(0, phraseIndex);
  const after = sentence.slice(phraseIndex + phraseLength);
  const preposed = [...before.matchAll(/(?:我|本人)([^我，,。；;！？!?\n]{0,36}?)[，,]?\s*(?:让|使|害|导致)[^，,。；;！？!?\n]{0,8}$/gu)].at(-1);
  const postposed = /^[，,]\s*(?:(?:(?:这|这个|这件事|这部分)(?:我知道|我明白)|我(?:也|确实)?(?:知道|明白))[，,]\s*)?(?:(?:是)?(?:因为|由于|缘于)\s*(?:我|本人)([^，,。；;！？!?\n]{1,36})|是(?:我|本人)([^，,。；;！？!?\n]{1,36}?)(?:导致|造成|让|使|害))/u.exec(after);
  if (!preposed && !postposed) return null;
  const key = waitingCauseKey(preposed?.[1] ?? postposed?.[1] ?? postposed?.[2] ?? "");
  return key || undefined;
}

function sourceAffirmsUserCausedPartnerWait(text: string, draft: { sentence: string; phraseIndex: number }, draftCause: string): boolean {
  const unquoted = withoutQuotedText(text);
  if (!unquoted) return false;
  const draftAnchor = lastAnchorBefore(draft.sentence, draft.phraseIndex);
  if (draftAnchor.ambiguous) return false;
  const sameEvent = (at: number) => {
    const anchor = lastAnchorBefore(unquoted, at);
    return !anchor.ambiguous && (draftAnchor.anchor === null || anchor.anchor === draftAnchor.anchor);
  };
  const matches = [...unquoted.matchAll(/(?:我|本人)([^我，,。；;！？!?\n]{0,36}?)[，,]?\s*(?:让|使|害|导致)\s*(?:她|他|对方|伴侣)(?:自己|当时|那时|现在|目前|也|还|一直|已经|正在|就|在)*(?:等待|等候|等着|等了|等过|等(?=我|他|她|你|对方|伴侣|回复|回应|消息|[，,。；;！？!？?\s]|$))/gu)];
  const affirmed = matches.flatMap(match => {
    const at = match.index ?? 0;
    const clause = match[0];
    const sentencePrefix = unquoted.slice(Math.max(0, unquoted.slice(0, at).search(/[^。；;！？!?\n]*$/u)), at);
    if (UNCERTAIN.test(sentencePrefix + clause) || REPORTED.test(sentencePrefix)
      || /我(?:想|觉得|认为|怀疑|猜)[^。；;！？!?\n]{0,24}$/u.test(sentencePrefix)
      || /(?:不是|并非|不|没|没有|未|从未|可能|也许|或许|打算|准备|将|会)(?:让|使|害|导致)/u.test(clause)) return [];
    const cause = /(?:让|使|害|导致)/u.exec(clause);
    if (!cause || !sameEvent(at + cause.index)) return [];
    let key = waitingCauseKey(match[1]!);
    // The actor may be bare before 让, with a concrete explanation after waiting.
    if (!key) {
      const tail = unquoted.slice(at + clause.length).split(/[。；;！？!?\n]/u)[0] ?? "";
      const because = /^[^。；;！？!?\n]{0,8}[，,]\s*(?:是)?(?:因为|由于|缘于)\s*(?:我|本人)([^，,。；;！？!?\n]{1,36})/u.exec(tail);
      key = because ? waitingCauseKey(because[1]!) : "";
    }
    return key ? [{ at, key }] : [];
  });
  type Update = { at: number; kind: "affirm" | "deny" | "unknown"; key?: string };
  const updates: Update[] = affirmed.map(({ at, key }) => ({ at, kind: "affirm", key }));
  for (const match of unquoted.matchAll(/(?:等待|等候|等着|等了|等过|等)(?:并)?(?:不是|并非|并不|不)([^，,。；;！？!?\n]{1,28}?)(?:造成|导致|引起|带来)的?/gu)) {
    const at = match.index ?? 0;
    if (sameEvent(at)) updates.push({ at, kind: "deny", key: waitingCauseKey(match[1]!.replace(/^(?:因|因为|由于)/u, "")) });
  }
  const sentences = [...unquoted.matchAll(/[^。；;！？!?\n]+[。；;！？!?\n]?/gu)]
    .map(match => ({ at: match.index ?? 0, text: match[0] }));
  for (const match of unquoted.matchAll(/(?:这件事|这个结果|这)(?:并)?(?:不是|并非|并不)(?:因为|由于|因)(?:我|本人)?([^，,。；;！？!?\n]{1,28})(?=[，,。；;！？!?\n]|$)/gu)) {
    const at = match.index ?? 0;
    const sentenceIndex = sentences.findIndex(sentence => at >= sentence.at && at < sentence.at + sentence.text.length);
    if (sentenceIndex < 0 || !sameEvent(at)) { updates.push({ at, kind: "unknown" }); continue; }
    const current = sentences[sentenceIndex]!;
    const prefix = current.text.slice(0, at - current.at);
    const context = /(?:让|使|害|导致)\s*(?:她|他|对方|伴侣)/u.test(prefix)
      ? prefix : sentences[sentenceIndex - 1]?.text ?? "";
    const effects = [...context.matchAll(/(?:让|使|害|导致)\s*(?:她|他|对方|伴侣)([^，,。；;！？!?\n]{1,24})/gu)];
    if (effects.length !== 1) { updates.push({ at, kind: "unknown" }); continue; }
    if (WAIT.test(effects[0]![1]!)) updates.push({ at, kind: "deny", key: waitingCauseKey(match[1]!) });
  }
  let allowed = false;
  for (const update of updates.sort((a, b) => a.at - b.at)) {
    if (update.kind === "unknown") allowed = false;
    else if (update.key && (update.kind === "affirm" ? causeEndpointMatches(draftCause, update.key)
      : draftCause.startsWith(update.key))) allowed = update.kind === "affirm";
  }
  return allowed;
}

function draftRecipientRole(introduction: string): "partner" | "other" | "none" {
  let tokens: Intl.Segments;
  try { tokens = new Intl.Segmenter("zh", { granularity: "word" }).segment(introduction); }
  catch { return "other"; }
  let hasRecipient = false;
  for (const token of tokens) {
    if (!/^(?:对|跟|向|给)$/u.test(token.segment)) continue;
    hasRecipient = true;
    const before = introduction.slice(0, token.index);
    const after = introduction.slice(token.index + token.segment.length).replace(/[:：]$/u, "");
    const recipient = /^(?:她|他|对方|伴侣)/u.exec(after)?.[0];
    if (!recipient) return "other";
    const remainder = after.slice(recipient.length);
    const messageObject = /^(?:(?:这样|这么|这|那)?(?:一|这)?(?:段|条|句|份)?(?:这样(?:的)?|这样的)?(?:话|文字|消息|开场|开头|内容))?$/u;
    const outgoing = /^(?:发|写|说|讲)/u.exec(remainder)?.[0];
    const valid = outgoing ? messageObject.test(remainder.slice(outgoing.length))
      : /^(?:的(?:消息|文字|话|回复)(?:可以|能)?(?:这样|这么)?(?:写|发|说))$/u.test(remainder)
        || (messageObject.test(remainder) && /(?:发|写|说|讲)$/u.test(before));
    if (token.segment === "给") {
      // 她给你 is incoming; 给她的消息/话 is an outgoing draft.
      if (/(?:她|他|对方|伴侣)\s*$/u.test(before) || !valid) return "other";
    } else if (!valid) return "other";
  }
  return hasRecipient ? "partner" : "none";
}

function firstPersonDraftQuote(reply: string, index: number, currentMessage: string, phrase: string): DraftQuoteMatch | null {
  const quotes = replyDraftSpans(reply);
  if (!quotes) return { kind: "blocked" };
  for (const quote of quotes) {
    const { start, end } = quote;
    const phraseIndex = quote.sourceOffsets.indexOf(index);
    if (phraseIndex < 0 || index < start || index >= end) continue;
    const previousQuoteEnd = quotes.filter(item => item.end <= start)
      .reduce((last, item) => Math.max(last, item.end), 0);
    const prefix = reply.slice(previousQuoteEnd, start).trimEnd();
    const boundary = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf("；"), prefix.lastIndexOf(";"), prefix.lastIndexOf("\n"));
    const introduction = prefix.slice(boundary + 1).replace(/\s+/gu, " ").trim();
    const genericExampleLead = /^(?:比如|例如)(?:说|如下)?[:：]?$/u.test(introduction);
    const sameParagraphDraft = genericExampleLead && exampleContextIsUserToPartner(paragraphBefore(reply, start));
    const roleContext = genericExampleLead ? paragraphBefore(reply, start) : introduction;
    const body = quote.body;
    if (quote.kind === "markdown" && body.split("\n").some(line => /^ {0,3}>/u.test(line))) return { kind: "blocked" };
    const innerQuotes = quoteSpans(body);
    if (!innerQuotes) return { kind: "blocked" };
    const inner = innerQuotes.filter(item => phraseIndex > item.start && phraseIndex < item.end - 1).sort((a, b) => b.depth - a.depth).at(0);
    if (inner) return { kind: "blocked" };
    if (typeof Intl.Segmenter !== "function") return { kind: "blocked" };
    const partnerSpeaker = /^(?:(?:伴侣|她|他|对方)(?:本人)?(?:也)?(?:可以|能|应该|先)?(?:这样说|用这段话说)|(?:可以|请|建议)?(?:让|请)(?:伴侣|她|他|对方)(?:本人)?(?:先)?(?:这样说|说))[:：]$/u;
    const userSpeaker = /^(?:(?:如果|假如)[^。！？!?；;]{0,40}[，,]\s*)?(?:你(?:可以|要|想|先|直接|把|用|对|跟|向|给|这样)|可以)[^。！？!?；;]{0,36}(?:这样说|用这句话说|这样开头|试试(?:这段话|这句话|这个开场)|(?:对|跟|向)(?:她|他|对方|伴侣)说|(?:发|写|说|讲|开口|开场|开头)(?:给(?:她|他|对方|伴侣))?)[:：]$/u;
    const partnerMessageFrame = /^给(?:她|他|对方|伴侣)的(?:消息|文字|话|回复)(?:可以|能)?(?:这样|这么)?(?:写|发|说)[:：]$/u;
    const delegatedSpeaker = /(?:让|请|叫|建议|替|要求|帮)(?:她|他|对方|伴侣|朋友|同事|家人|别人|第三人|其他人|小[\p{Script=Han}]{1,2})[^，,：:]{0,18}(?:发|写|说|讲|开口|开场|开头)/u;
    const quotedOtherSpeech = /(?:回想|想起|记起)(?:她|他|对方|伴侣|朋友|同事)(?:刚才|当时|之前)?(?:这样|这么)?(?:说|写)[:：]$|(?:引用|引述|转述|复述|照搬)(?:她|他|对方|伴侣|朋友|同事)(?:刚才|当时|之前)?(?:的话|那段|的原话|说过的话|说|写)[^：:]{0,12}[:：]$/u;
    const recipientRole = draftRecipientRole(introduction);
    const effectiveRecipientRole = sameParagraphDraft ? "partner" : recipientRole;
    if (partnerSpeaker.test(introduction)
      || delegatedSpeaker.test(introduction)
      || quotedOtherSpeech.test(introduction)
      || recipientRole === "other") return { kind: "blocked" };
    if (genericExampleLead && (delegatedSpeaker.test(roleContext) || quotedOtherSpeech.test(roleContext)
      || /(?:她|他|对方|伴侣)(?:本人)?(?:也)?(?:可以|能|应该|先)?(?:这样说|用这段话说)/u.test(roleContext))) return { kind: "blocked" };
    const outgoingUserDraft = /^你(?:可以|先|要|想|直接)?(?:给|对|跟|向)(?:她|他|对方|伴侣)(?:发|写|说|讲)[^:：。！？!?；;]{0,18}[:：]$/u.test(introduction)
      || /^你(?:可以|先|要|想|直接)?(?:发|写|说|讲)(?:给|对|跟|向)(?:她|他|对方|伴侣)[^:：。！？!?；;]{0,18}[:：]$/u.test(introduction);
    const userDraft = sameParagraphDraft || userSpeaker.test(introduction) || hasConditionalUserDraftSubject(introduction)
      || (effectiveRecipientRole === "partner" && outgoingUserDraft);
    if (!userDraft && !partnerMessageFrame.test(introduction)) return { kind: "blocked" };
    if (!hasSameSentenceKnowledge(body, phraseIndex)) return { kind: "blocked" };
    let sentenceStart = 0, sentenceEnd = body.length;
    for (const mark of body.matchAll(/[。！？!?；;\n]/gu)) {
      const at = mark.index ?? 0;
      if (at < phraseIndex) sentenceStart = at + mark[0].length;
      else { sentenceEnd = at; break; }
    }
    const draft = { kind: "partner" as const, sentence: body.slice(sentenceStart, sentenceEnd), phraseIndex: phraseIndex - sentenceStart, phraseLength: phrase.length };
    if (effectiveRecipientRole === "none" && (hasCompetingRecipientIntent(currentMessage) || !hasAffirmedPartnerWaiting(currentMessage, draft))) return { kind: "blocked" };
    return draft;
  }
  return null;
}

function structuredDraftQuote(reply: string, index: number, currentMessage: string, priorUserMessages: string[], phrase: string, ranges: PrivateDraftRange[]): DraftQuoteMatch | null {
  const range = ranges.find(item => index >= item.start && index + phrase.length <= item.end);
  if (!range) return null;
  const body = reply.slice(range.start, range.end);
  const phraseIndex = index - range.start;
  const quotes = quoteSpans(body);
  if (!quotes || quotes.some(item => phraseIndex > item.start && phraseIndex < item.end - 1)) return { kind: "blocked" };
  if (!hasSameSentenceKnowledge(body, phraseIndex)) return { kind: "blocked" };
  let sentenceStart = 0, sentenceEnd = body.length;
  for (const mark of body.matchAll(/[。！？!?；;\n]/gu)) {
    const at = mark.index ?? 0;
    if (at < phraseIndex) sentenceStart = at + mark[0].length;
    else { sentenceEnd = at; break; }
  }
  const draft = { kind: "partner" as const, sentence: body.slice(sentenceStart, sentenceEnd), phraseIndex: phraseIndex - sentenceStart, phraseLength: phrase.length };
  if (!ownerToPartnerDraftContextAllowed(currentMessage, priorUserMessages) || !hasAffirmedPartnerWaiting(currentMessage, draft)) return { kind: "blocked" };
  return draft;
}

export function guardPrivateReplyFidelity(reply: string, input: {
  currentMessage: string; priorUserMessages?: FidelitySource[]; ownerCorrections?: FidelityCorrection[];
  knownMemoryCorrections?: KnownMemoryCorrection[]; draftRanges?: PrivateDraftRange[];
}): string {
  if (input.draftRanges !== undefined) {
    let previousEnd = 0;
    for (const range of input.draftRanges) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
        || range.start < previousEnd || range.start >= range.end || range.end > reply.length) {
        throw new SourceFidelityError("invalid_draft_ranges");
      }
      previousEnd = range.end;
    }
  }
  const evidence=[input.currentMessage];
  const relevantCorrections: string[]=[];
  // Only a narrow explicit correction retains the immediately previous report.
  // Arbitrary waiting in another historical episode never authorizes this one.
  if(/更正|纠正|核对/.test(input.currentMessage) && /其[他它](?:事实|部分)?不变/.test(input.currentMessage)) {
    const previous=input.priorUserMessages?.at(-1);
    if(previous && Number.isInteger(previous.version) && previous.version>0) {
      evidence.unshift(previous.content);
      relevantCorrections.push(...(input.ownerCorrections??[]).filter(row=>row.sourceMessageIds.includes(previous.id)).map(row=>row.content));
    }
  }
  const matches=/(?:你|我|用户)(?:上个月|这个月|上周|本周|去年|今年|昨天|今天|前天|明天|那天|那晚|那夜|当时|那时|现在|目前|一直|已经|确实|正在|可能|也许|或许|是否|是不是|并没有|没有|不是|并非|从未|没|还|也|在){0,5}(?:等待|等候|等着|等了|等过|等(?=我|他|她|你|对方|伴侣|回复|回应|消息|的时候|时|[，,。；;！？!?\s]|$))(?:我|他|她|你|对方|伴侣|回复|回应|消息)?(?:的时候|时)?/g;
  const checkWaiting = (phrase: string, index: number, subject = /^(你|我|用户)/u.exec(phrase)?.[0], inheritedAnchor?: string, allowElision = true): string => {
    if(uncertainWaiting(reply,index,phrase)) return phrase;
    const anchor=inheritedAnchor ?? TIME.exec(localPrefix(reply,index)+phrase)?.[0];
    const draftQuote = subject === "你"
      ? input.draftRanges !== undefined
        ? structuredDraftQuote(reply,index,input.currentMessage,input.priorUserMessages?.map(source=>source.content)??[],phrase,input.draftRanges)
        : firstPersonDraftQuote(reply,index,input.currentMessage,phrase)
      : null;
    if (draftQuote?.kind === "blocked") throw new SourceFidelityError("unsupported_waiting_premise");
    const draftedPartnerQuote = draftQuote?.kind === "partner" ? draftQuote : null;
    const draftedPartnerAddress = draftedPartnerQuote !== null;
    const explicitDenial = !draftedPartnerAddress && (deniesWaiting(input.currentMessage,anchor)
      || (!ownWaiting(input.currentMessage,anchor) && relevantCorrections.some(source=>deniesWaiting(source,anchor))));
    const sourceSupportsWaiting = draftedPartnerQuote
      ? hasAffirmedPartnerWaiting(input.currentMessage,draftedPartnerQuote)
      : evidence.some(source=>ownWaiting(source,anchor));
    const draftCause = draftedPartnerQuote
      ? draftWaitingCause(draftedPartnerQuote.sentence, draftedPartnerQuote.phraseIndex,draftedPartnerQuote.phraseLength) : null;
    const unsupportedCause = draftedPartnerQuote && draftCause !== null
      && (!draftCause || !sourceAffirmsUserCausedPartnerWait(input.currentMessage, draftedPartnerQuote, draftCause));
    if(!explicitDenial && sourceSupportsWaiting && !unsupportedCause) return phrase;
    // Removing a temporal adjunct does not assert any different action.
    if(allowElision && /(?:的时候|时)$/.test(phrase) && !/(?:我|我们)(?:知道|明白|确定|记得|确认)[^，,。]{0,8}$/.test(localPrefix(reply,index))) return /^(你|我|用户)/.exec(phrase)![0]+"当时";
    throw new SourceFidelityError("unsupported_waiting_premise");
  };
  for (const mention of implicitWaitingMentions(reply, input.draftRanges)) {
    if (!mention.conditional && !mention.negated && mention.subject === "ambiguous") throw new SourceFidelityError("unsupported_waiting_premise");
    if (!mention.conditional && !mention.negated && /^(?:你|我|用户)$/u.test(mention.subject))
      checkWaiting(mention.phrase, mention.index, mention.subject, mention.anchor, false);
  }
  const guarded = reply.replace(matches, (phrase: string, index: number) => checkWaiting(phrase, index));
  for (const correction of input.knownMemoryCorrections ?? []) {
    const oldText = minuteAlternatives(correction.oldMinutes);
    const newText = minuteAlternatives(correction.newMinutes);
    const measure = correction.measure === "迟到" ? "(?:迟到|晚到|迟了|晚了)" : "(?:等待|等候|等着|等了|等过|等)";
    const hasOtherEvent = hasOtherExplicitEventTopic(input.currentMessage, correction.topic);
    const namesTopic = input.currentMessage.includes(correction.topic) && !hasOtherEvent;
    const refersBack = /那次|那件事|这件事|接着|继续|之前说的|那个安排/u.test(input.currentMessage)
      && !hasOtherEvent
      && (input.priorUserMessages ?? []).slice(-2).some(message => message.content.includes(correction.topic));
    const currentOwnerText = input.currentMessage.replace(QUOTES, "");
    const currentSourceAffirmsTopicOld = currentOwnerText.split(/[，,。；;！？!?\n]/).some(clause =>
      clause.includes(correction.topic)
      && !hasOtherExplicitEventTopic(clause, correction.topic)
      && new RegExp(`${measure}[^。；;！？!?]{0,20}${oldText}\\s*分钟|${oldText}\\s*分钟[^。；;！？!?]{0,20}${measure}`).test(clause)
      && !/[“「『‘"'][^”」』’"']*[”」』’"']/u.test(clause)
      && !REPORTED.test(clause)
      && !/(?:不是|并非|并没有|没有|没|从未|不曾|不确定|不知道|听说|据说|如果|假如|可能|也许|或许|引用|更正为|改为|纠正为)/u.test(clause));
    // An explicitly current, separate event may share the corrected old number.
    // Require this exact owner-authored fact in the reply; a verb prefix alone
    // is never evidence of another event.
    const currentOtherEventFacts = currentOwnerText.split(/[，,。；;！？!?\n]/).filter(clause =>
      !clause.includes(correction.topic)
      && /今天|昨天|昨晚|这次|另一次|另一件事|新的|新一次/u.test(clause)
      && new RegExp(`${measure}[^。；;！？!?]{0,20}${oldText}\\s*分钟|${oldText}\\s*分钟[^。；;！？!?]{0,20}${measure}`).test(clause)
      && !/[“「『‘"'][^”」』’"']*[”」』’"']/u.test(clause)
      && !REPORTED.test(clause)
      && !/(?:不是|并非|并没有|没有|没|从未|不曾|不确定|不知道|听说|据说|如果|假如|可能|也许|或许|引用|更正|纠正|改为|[吗么])/u.test(clause));
    // Keep commas inside one sentence so a historical comparison such as
    // “之前记20分钟，已更正10分钟” remains explicitly historical.
    const sentenceParts = [...guarded.matchAll(/[^。；;！？!?\n]+/g)].map(match => ({ text: match[0], start: match.index ?? 0 }));
    for (const { text: sentence, start: sentenceStart } of sentenceParts) {
      const commaParts = sentence.split(/[，,]/);
      const ranges = [...sentence.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|'[^']*'/g)]
        .map(match => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
      for (const [partIndex, part] of commaParts.entries()) {
        if (!namesTopic && !refersBack && !part.includes(correction.topic)) continue;
        // Keep a correction scoped to its event when a reply mentions another
        // event with the same measure and number.
        if (hasOtherExplicitEventTopic(part, correction.topic)) continue;
        const relationPattern = new RegExp(`${measure}[^。；;！？!?]{0,20}${oldText}\\s*分钟|${oldText}\\s*分钟[^。；;！？!?]{0,20}${measure}`, "g");
        for (const match of part.matchAll(relationPattern)) {
          const localAt = match.index ?? 0;
          const sentenceAt = commaParts.slice(0, partIndex).reduce((sum, value) => sum + value.length + 1, 0) + localAt;
          const insideDraft = input.draftRanges?.some(range => sentenceStart + sentenceAt >= range.start && sentenceStart + sentenceAt < range.end);
          // Keep historical quotations in narration; a sendable draft is a
          // current assertion. A rewritten string loses original offsets, so
          // ambiguous quoted claims are checked rather than exempted.
          if (ranges.some(([start, end]) => sentenceAt >= start && sentenceAt < end)
            && (input.draftRanges === undefined || (guarded === reply && !insideDraft))) continue;
          const before = part.slice(Math.max(0, localAt - 20), localAt);
          if (/(?:没有|没|并未|不是|并非|从未|不曾|不确定|不知道)\s*$/u.test(before)) continue;
          const afterOld = part.slice(localAt + match[0].length);
          const nextPart = commaParts[partIndex + 1] ?? "";
          const historicalCue = /(?:之前|以前|原来|原先|曾经|更正前|旧说法|之前记(?:为)?)/.test(before);
          const correctionCue = /(?:已(?:经)?更正|改为|纠正为|现在是)/.test(afterOld)
            || /(?:已(?:经)?更正|改为|纠正为|现在是)/.test(nextPart);
          const correctedNumber = new RegExp(`${newText}\\s*分钟`).test(afterOld) || new RegExp(`${newText}\\s*分钟`).test(nextPart);
          if (historicalCue && correctionCue && correctedNumber) continue;
          const afterRelation = part.slice(localAt + match[0].length, localAt + match[0].length + 24);
          const oldOffset = match[0].search(new RegExp(oldText));
          const beforeOld = oldOffset >= 0 ? part.slice(Math.max(0, localAt + oldOffset - 12), localAt + oldOffset) : before;
          const deniesOld = /(?:不是|并非|并没有|没有|没|从未|不曾)\s*$/u.test(beforeOld);
          const explicitlyWithdrawn = /^(?:已经)?(?:更正|纠正|改为|作废|不再成立|不是事实|不应作为当前事实)/.test(afterRelation)
            || /^(?:已经)?(?:作废|不再成立|不是事实|不应作为当前事实)/.test(nextPart);
          if (explicitlyWithdrawn || deniesOld) continue;
          if (!part.includes(correction.topic) && currentOtherEventFacts.some(source =>
            part.replace(/\s/g, "").includes(source.trim().replace(/\s/g, "")))) continue;
          if (currentSourceAffirmsTopicOld && part.includes(correction.topic)) continue;
          throw new SourceFidelityError("superseded_memory_value");
        }
      }
    }
  }
  return guarded;
}

interface Cause { cause: string; effect: string; whole: string; }
function causeRelation(content: string): Cause | null {
  const relation=/(?:用户|我)(?:全部|完全|全都|只|仅|主要)?(?:因(?:为)?|由于)([^，,。；;！？!?\n]{1,120}?)(?:而|所以)([^，,。；;！？!?\n]{1,120})/.exec(content);
  if(relation) return {cause:relation[1]!,effect:relation[2]!,whole:relation[0]};
  const nounFirst=/(?:用户|我)(?:的)?([^，,。；;！？!?\n]{1,50}?)(?:是)?(?:因为|由于)([^，,。；;！？!?\n]{1,120})/.exec(content);
  if(nounFirst) return {cause:nounFirst[2]!,effect:nounFirst[1]!.replace(/(?:全部|完全|全都|只|仅|主要)$/,""),whole:nounFirst[0]};
  const inverted=/(?:让|使)(?:我|用户)([^，,。；;！？!?\n]{1,50}?)的(?:就是|是)([^，,。；;！？!?\n]{1,120})/.exec(content);
  if(inverted) return {cause:inverted[2]!,effect:inverted[1]!,whole:inverted[0]};
  const direct=/([^，,。；;！？!?\n]{1,120}?)(?:让|使)(?:我|用户)([^，,。；;！？!?\n]{1,120})/.exec(content);
  return direct ? {cause:direct[1]!,effect:direct[2]!,whole:direct[0]} : null;
}
function normalized(text: string): string {
  return text.replace(/[“”‘’"'「」『』\s]/g,"").replace(/^(?:用户|本人|我)(?:当时|那时)?/,"").replace(/迟到/g,"晚到");
}
function causeKey(text: string): string {
  return normalized(text).replace(/^(?:这次|当时|那时)/,"").replace(/(?:这件事|这件事情|这事)$/ ,"");
}
function effectKey(text: string): string {
  return normalized(text).replace(/^(?:(?:感到|觉得|感受(?:到)?|有(?:一点|些|点)?|很|挺|确实))+/ ,"");
}
function causeEndpointMatches(noteCause: string, sourceCause: string): boolean {
  const wanted = causeKey(noteCause);
  const source = causeKey(sourceCause);
  // Notes may add the modal 会 between an affirmed cause and a direct 让/使
  // construction. Keep this exact: trimming a generic trailing 会 corrupts
  // source nouns such as 约会.
  return wanted === source || wanted === `${source}会`;
}
function affirmedSourceRelation(text: string): Cause | null {
  if(REPORTED.test(text)||UNCERTAIN.test(text)||/[吗么？?]/.test(text)||/(?:不是|并非|并不|不)(?:因|因为|由于)|不是.*(?:让|使)我/.test(text)) return null;
  return causeRelation(text);
}
function endpointPresent(endpoint: string, sources: string[], feeling: boolean): boolean {
  const wanted=feeling ? effectKey(endpoint) : causeKey(endpoint);
  if(!wanted) return false;
  return sources.some(text=>clauses(text).some(clause=>{
    if(REPORTED.test(clause)||UNCERTAIN.test(clause)) return false;
    const explicit=affirmedSourceRelation(clause);
    if(explicit) return feeling
      ? effectKey(explicit.effect)===wanted
      : causeEndpointMatches(endpoint, explicit.cause);
    if(feeling && !/(?:我|本人)[^，,。]{0,24}(?:感到|觉得|有(?:些|点|一点)?|很|挺|失落|难过|生气|担心)/.test(clause)) return false;
    if(/(?:没有|并未|并非|不是|没|不曾|从未)[^，,。]{0,8}$/.test(normalized(clause).split(wanted)[0]??"")) return false;
    return normalized(clause).includes(wanted);
  }));
}
function deniedRelation(relation: Cause, texts: string[]): boolean {
  const cause=causeKey(relation.cause).replace(/^(?:伴侣|对方|他|她)/,""), effect=effectKey(relation.effect);
  return texts.some(text=>text.split(/[。；;！？!?\n]/).some(sentence=>{
    const parts=clauses(sentence);
    return parts.some((clause,index)=>{
      const preceding=parts[index-1]??"";
      const hasEffect=normalized(clause).includes(effect)
        || (/(?:我|本人)[^，,。]{0,16}/.test(preceding) && !REPORTED.test(preceding) && !UNCERTAIN.test(preceding) && normalized(preceding).includes(effect));
      if(/(?:不是|并非|并不|不)(?:因为|由于|因)/.test(clause) && !/不知道|不确定|是不是/.test(clause) && normalized(clause).includes(cause) && hasEffect) return true;
      return /不是我的意思|我没有这么说|我还不知道|我不确定/.test(clause) && /笔记|你.{0,5}写|你的理解/.test(clause) && normalized(clause).includes(effect) && /因|因为|由于/.test(clause);
    });
  }));
}
function explicitlySupported(relation: Cause, sources: string[]): boolean {
  return sources.some(text=>clauses(text).some(clause=>{
    const sourceRelation=affirmedSourceRelation(clause);
    return sourceRelation && causeEndpointMatches(relation.cause, sourceRelation.cause) && effectKey(sourceRelation.effect)===effectKey(relation.effect);
  }));
}

// A deliberately narrow matching view for a single numeric correction. Original
// text, IDs and versions are retained; ambiguous edits never inherit causality.
function numericCorrectionViews(messages: FidelitySource[]): Map<string,{content:string;correctionId:string}> {
  const views=new Map<string,{content:string;correctionId:string}>();
  const atom=/[零〇一二两三四五六七八九十百千万\d]+(?:\.\d+)?(?:分钟|小时|天|周|个月|年|次|公里|米|元)/g;
  for(let index=1;index<messages.length;index++) {
    const correction=messages[index]!, previous=messages[index-1]!;
    if(!/更正|纠正/.test(correction.content)||!/其[他它](?:事实|部分)?不变/.test(correction.content)||/不是因为|并非因|并不因|不因|不是我的意思|没有这么说/.test(correction.content)) continue;
    const oldAtoms=previous.content.match(atom)??[], newAtoms=correction.content.match(atom)??[];
    if(oldAtoms.length!==1||newAtoms.length!==1) continue;
    const oldAtom=oldAtoms[0]!, newAtom=newAtoms[0]!;
    if(oldAtom.replace(/^[零〇一二两三四五六七八九十百千万\d.]+/,"")!==newAtom.replace(/^[零〇一二两三四五六七八九十百千万\d.]+/,"")) continue;
    const relation=clauses(previous.content).map(affirmedSourceRelation).find(value=>value?.cause.includes(oldAtom));
    if(!relation) continue;
    const target=clauses(correction.content).find(clause=>clause.includes(newAtom))?.replace(/^(?:更正|纠正)(?:一下)?[：:]?/,"").replace(/^是/,"").trim();
    if(!target) continue;
    const stem=target.slice(0,target.indexOf(newAtom)).trim();
    const oldStem=causeKey(relation.cause).slice(0,causeKey(relation.cause).indexOf(oldAtom));
    if(!stem||!oldStem.endsWith(stem)||target.slice(target.indexOf(newAtom)+newAtom.length).trim()) continue;
    views.set(previous.id,{content:previous.content.replace(oldAtom,newAtom),correctionId:correction.id});
  }
  return views;
}

// A missing detail in this chat input is not itself an unresolved life fact.
// Select only this explicit omission shape; ordinary sourced unknowns survive.
function isChatInputOmission(note: FidelityNote): boolean {
  // Mixed notes can contain a real unresolved matter beside the omission.
  // Keep them conservatively; this selection only recognizes pure metadata.
  const sentences=note.content.split(/[。！？!?；;\n]/u).filter(part=>part.trim());
  return note.kind === "unknown"
    && sentences.length === 1
    && !/不记得|记不清|不知道|不清楚|不确定|是否|是不是|未知/u.test(note.content)
    && /(?:本次|本轮|这次|此次|当前|这条|本条)(?:用户)?(?:消息|原话|输入|发言|对话)[^。；;\n]{0,12}(?:未(?:曾)?|(?:并)?没有|没)(?:说明|提供|提及|交代|描述)/u.test(note.content)
    && /(?:无法|不能|无从|尚不能)(?:确认|确定)[。！？!?\s]*$/u.test(note.content);
}

export function normalizePrivateNotesFidelity(raw: unknown, input: {
  messages: FidelitySource[]; ownerCorrections?: FidelityCorrection[];
}): FidelityNote[] {
  if(!Array.isArray(raw)||raw.length>30) throw new SourceFidelityError("invalid_notes_batch");
  const byId=new Map(input.messages.map(source=>[source.id,source]));
  const matchingViews=numericCorrectionViews(input.messages);
  const allCorrections=input.ownerCorrections??[];
  return raw.map<FidelityNote>(entry=>{
    if(!entry||typeof entry!=="object"||Array.isArray(entry)) throw new SourceFidelityError("invalid_note");
    const row=entry as Record<string,unknown>;
    if(typeof row.kind!=="string"||!["user_statement","tentative_understanding","unknown"].includes(row.kind)||typeof row.content!=="string"||!row.content.trim()||row.content.trim().length>1000||!Array.isArray(row.sourceMessageIds)||!row.sourceMessageIds.length) throw new SourceFidelityError("invalid_note");
    if(row.sourceMessageIds.some(id=>typeof id!=="string"||!byId.has(id)||!Number.isInteger(byId.get(id)!.version)||byId.get(id)!.version<1)) throw new SourceFidelityError("invalid_note_source");
    const sourceMessageIds=[...new Set(row.sourceMessageIds as string[])];
    const content=row.content.trim();
    const sources=sourceMessageIds.map(id=>{
      const view=matchingViews.get(id);
      return view && sourceMessageIds.includes(view.correctionId) ? view.content : byId.get(id)!.content;
    });
    sources.push(...allCorrections.filter(correction=>correction.sourceMessageIds.some(id=>sourceMessageIds.includes(id))).map(correction=>correction.content));
    // Only an explicit reality conflict is handled here. A hypothetical clause
    // elsewhere in a message cannot invalidate its independently real report.
    if(/现实(?:中|今天|这次)?/.test(content) && sources.some(source=>/现实[^，,。；;]{0,12}(?:没发生|没有发生|并未发生)/.test(source))) throw new SourceFidelityError("unsupported_note_reality_scope");
    const relation=causeRelation(content);
    if(relation) {
      // A superseded numeric report cannot revive its old value by omitting the
      // correction. Both sources must survive edits/deletion for this relation.
      if(sourceMessageIds.some(id=>matchingViews.has(id)&&!sourceMessageIds.includes(matchingViews.get(id)!.correctionId))) throw new SourceFidelityError("missing_note_correction_dependency");
      // A later same-range correction can invalidate a claim citing old IDs.
      const currentTexts=[...input.messages.map(source=>source.content),...allCorrections.map(correction=>correction.content)];
      if(deniedRelation(relation,currentTexts)) throw new SourceFidelityError("denied_note_causality");
      if(/全部|完全|全都|唯一|仅仅|只因|只因为/.test(relation.whole) && !sources.some(source=>!UNCERTAIN.test(source)&&!REPORTED.test(source)&&normalized(source).includes(normalized(relation.whole)))) throw new SourceFidelityError("unsupported_note_causal_degree");
      if(!endpointPresent(relation.cause,sources,false)||!endpointPresent(relation.effect,sources,true)) throw new SourceFidelityError("unsupported_note_endpoint");
      if(!explicitlySupported(relation,sources)) return {kind:"tentative_understanding",content:"尚未由用户确认的可能理解："+content,sourceMessageIds};
    }
    return {kind:row.kind as FidelityNote["kind"],content,sourceMessageIds};
  }).filter(note=>!isChatInputOmission(note));
}
