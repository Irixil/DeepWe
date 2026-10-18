import crypto from "node:crypto";
import { db } from "./db.js";

export type PrivateMemoryKind = "user_statement" | "tentative_understanding" | "unknown";
export interface PrivateMemoryItem {
  id: string;
  kind: PrivateMemoryKind;
  content: string;
  version: number;
  updatedAt: number;
  sourceConversationId: string;
  sourceMessageIds: string[];
  sourceMessageVersions: Record<string, number>;
  correction?: string;
  correctionStatus?: "applied";
  supersedes?: Array<{
    memoryItemId: string; itemVersion: number; sourceConversationId: string;
    sourceMessageIds: string[]; sourceMessageVersions: Record<string, number>;
  }>;
}
export interface PendingMemoryCorrection {
  id: string; version: number; status: "needs_clarification"; sourceConversationId: string;
  sourceMessageIds: string[]; sourceMessageVersions: Record<string, number>;
  reason: "ambiguous_change" | "ambiguous_target" | "no_target";
  content?: string; candidateMemoryItemIds?: string[];
  candidates?: PrivateMemoryItem[];
}
export interface PrivateMemoryView { enabled: boolean; revision: number; items: PrivateMemoryItem[]; pendingCorrections: PendingMemoryCorrection[]; }
export interface PrivateMemoryPromptItem extends PrivateMemoryItem {
  sourceMessageTimes: Array<{ id: string; version: number; originalCreatedAtUtc: string }>;
}
export interface KnownMemoryCorrection {
  topic: string; measure: "迟到" | "等待" | "等候" | "等"; oldMinutes: number; newMinutes: number;
  sourceConversationId: string; sourceMessageId: string; sourceMessageVersion: number;
}
export interface MemoryReplySnapshot { enabled: boolean; epoch: number; items: PrivateMemoryPromptItem[]; pendingCorrections: PendingMemoryCorrection[]; knownCorrections: KnownMemoryCorrection[]; }
interface ItemRow {
  id: string; owner_user_id: string; kind: PrivateMemoryKind; content: string; version: number;
  source_conversation_id: string; source_note_id: string; source_message_ids: string;
  source_message_versions: string; source_fingerprint: string; correction: string | null; correction_metadata: string | null;
  locked: number; status: string; updated_at: number;
}

const now = () => Date.now();
const defaultState = { enabled: false, revision: 1, epoch: 1 };

function activePendingSourceVersions(ownerUserId: string): Set<string> {
  const rows = db.prepare(`SELECT source_message_ids,source_message_versions,correction_metadata FROM private_memory_items
    WHERE owner_user_id=? AND status='needs_clarification'`).all(ownerUserId) as Array<{source_message_ids:string;source_message_versions:string;correction_metadata:string|null}>;
  const blocked = new Set<string>();
  for (const row of rows) {
    try {
      const metadata = row.correction_metadata ? JSON.parse(row.correction_metadata) as {type?:string} : {};
      if (metadata.type !== "natural_correction_pending" && metadata.type !== "pending_correction_candidate") continue;
      const ids = JSON.parse(row.source_message_ids) as unknown;
      const versions = JSON.parse(row.source_message_versions) as Record<string, unknown>;
      if (!Array.isArray(ids) || !versions || typeof versions !== "object" || Array.isArray(versions)) continue;
      for (const id of ids) if (typeof id === "string" && Number.isInteger(versions[id])) blocked.add(`${id}:${versions[id]}`);
    } catch { /* malformed pending provenance cannot authorize a note */ }
  }
  return blocked;
}

function rowUsesPendingSource(row: ItemRow, blocked: Set<string>): boolean {
  try {
    const ids = JSON.parse(row.source_message_ids) as unknown;
    const versions = JSON.parse(row.source_message_versions) as Record<string, unknown>;
    return Array.isArray(ids) && ids.some(id => typeof id === "string" && blocked.has(`${id}:${versions[id]}`));
  } catch { return true; }
}

function stateFor(ownerUserId: string): { enabled: boolean; revision: number; epoch: number } {
  const row = db.prepare(`SELECT enabled,revision,epoch FROM private_memory_settings WHERE owner_user_id=?`).get(ownerUserId) as { enabled: number; revision: number; epoch: number } | undefined;
  return row ? { enabled: row.enabled === 1, revision: row.revision, epoch: row.epoch } : defaultState;
}

// These separators are added by the correction-context derivation. Preserve
// quoted source wording and all sentence-ending punctuation when tidying them.
function formatDerivedContext(content: string): string {
  const clauses: string[] = [];
  let clause = "", escaped = false;
  const quoteEnds: string[] = [];
  const quotePairs: Record<string, string> = { "“": "”", "‘": "’", "「": "」", "『": "』", '"': '"', "'": "'" };
  for (const character of content) {
    clause += character;
    const escapedCharacter = escaped;
    escaped = character === "\\" && !escaped;
    if (quoteEnds.length) {
      if (!escapedCharacter && character === quoteEnds.at(-1)) quoteEnds.pop();
      else if (!escapedCharacter && quotePairs[character]) quoteEnds.push(quotePairs[character]);
    } else if (!escapedCharacter && quotePairs[character]) {
      quoteEnds.push(quotePairs[character]);
    } else if (/[；;]/u.test(character)) {
      clauses.push(clause); clause = "";
    }
  }
  // Incomplete quoted material is not safe to reformat.
  if (quoteEnds.length) return content;
  clauses.push(clause);
  return clauses.map(part => part.trim().replace(/^[，,；;]+|[，,；;]+$/gu, "").trim())
    .filter(Boolean).reduce((joined, part) => joined
      ? `${joined}${/[。.!！?？]$/u.test(joined) ? "" : "；"}${part}` : part, "");
}

function decode(row: ItemRow): PrivateMemoryItem {
  const sourceMessageIds = JSON.parse(row.source_message_ids) as string[];
  const sourceMessageVersions = JSON.parse(row.source_message_versions) as Record<string, number>;
  let metadata: { type?: string; supersedes?: PrivateMemoryItem["supersedes"] } = {};
  try { metadata = row.correction_metadata ? JSON.parse(row.correction_metadata) as typeof metadata : {}; } catch { /* malformed metadata is never used as an instruction */ }
  return { id: row.id, kind: row.kind,
    content: metadata.type === "natural_correction_context" ? formatDerivedContext(row.content) : row.content,
    version: row.version,
    updatedAt: row.updated_at, sourceConversationId: row.source_conversation_id,
    sourceMessageIds, sourceMessageVersions, ...(row.correction ? { correction: row.correction } : {}),
    ...(metadata.type === "natural_correction_applied" ? { correctionStatus: "applied" as const, supersedes: metadata.supersedes ?? [] } : {}) };
}

function listCurrent(ownerUserId: string): PrivateMemoryItem[] {
  const pendingSources = activePendingSourceVersions(ownerUserId);
  const rows = db.prepare(`SELECT m.* FROM private_memory_items m
    JOIN private_conversations c ON c.id=m.source_conversation_id AND c.owner_user_id=m.owner_user_id
    WHERE m.owner_user_id=? AND m.status='current' AND c.status='active' ORDER BY m.updated_at DESC,m.id`).all(ownerUserId) as ItemRow[];
  return rows.filter(row => sourcesStillCurrent(row) && !rowUsesPendingSource(row, pendingSources)).map(decode);
}

function listPendingCorrections(ownerUserId: string): PendingMemoryCorrection[] {
  const rows = db.prepare(`SELECT m.* FROM private_memory_items m
    JOIN private_conversations c ON c.id=m.source_conversation_id AND c.owner_user_id=m.owner_user_id
    WHERE m.owner_user_id=? AND m.status='needs_clarification' AND c.status='active'
    ORDER BY m.updated_at DESC,m.id`).all(ownerUserId) as ItemRow[];
  return rows.flatMap(row => {
    if (!sourcesStillCurrent(row)) return [];
    try {
      const metadata = row.correction_metadata ? JSON.parse(row.correction_metadata) as {
        type?: string; reason?: PendingMemoryCorrection["reason"]; candidateMemoryItemIds?: string[];
      } : {};
      if (metadata.type !== "natural_correction_pending" || !metadata.reason) return [];
      const sourceMessageIds = JSON.parse(row.source_message_ids) as string[];
      const sourceMessageVersions = JSON.parse(row.source_message_versions) as Record<string, number>;
      const cutoff = sourceMessageIds.some(id => {
        const version = db.prepare(`SELECT source_message_version FROM private_memory_cutoff_sources WHERE owner_user_id=? AND source_message_id=?`).get(ownerUserId, id) as { source_message_version: number } | undefined;
        return version?.source_message_version === sourceMessageVersions[id];
      });
      if (cutoff) return [];
      const candidateMemoryItemIds = (metadata.candidateMemoryItemIds ?? []).filter(id => typeof id === "string");
      const candidates = candidateMemoryItemIds.flatMap(id => {
        const candidate = db.prepare(`SELECT * FROM private_memory_items WHERE id=? AND owner_user_id=? AND status='needs_clarification'`).get(id, ownerUserId) as ItemRow | undefined;
        return candidate && sourcesStillCurrent(candidate) ? [decode(candidate)] : [];
      });
      return [{
        id: row.id, version: row.version, status: "needs_clarification" as const, sourceConversationId: row.source_conversation_id,
        sourceMessageIds, sourceMessageVersions, reason: metadata.reason, content: row.content,
        candidateMemoryItemIds: candidates.map(item => item.id), candidates,
      }];
    } catch { return []; }
  });
}

function sourcesStillCurrent(row: ItemRow): boolean {
  try {
    const ids = JSON.parse(row.source_message_ids) as unknown;
    const versions = JSON.parse(row.source_message_versions) as unknown;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string") || !versions || typeof versions !== "object" || Array.isArray(versions)) return false;
    const versionMap = versions as Record<string, unknown>;
    if (Object.keys(versionMap).length !== ids.length || ids.some(id => !Number.isInteger(versionMap[id]))) return false;
    const source = db.prepare(`SELECT m.id,m.version FROM private_messages m JOIN private_conversations c ON c.id=m.conversation_id
      WHERE c.owner_user_id=? AND c.id=? AND c.status='active' AND m.role='user' AND m.status='current'
      AND m.id IN (${ids.map(() => "?").join(",")})`).all(row.owner_user_id, row.source_conversation_id, ...ids) as { id: string; version: number }[];
    return source.length === ids.length && source.every(item => item.version === versionMap[item.id]);
  } catch { return false; }
}

function fingerprint(ids: string[], versions: Record<string, number>): string {
  const pairs = [...ids].sort().map(id => `${id}:${versions[id]}`).join("|");
  return crypto.createHash("sha256").update(pairs).digest("hex");
}

function saveState(ownerUserId: string, enabled: boolean, revision: number, epoch: number): void {
  db.prepare(`INSERT INTO private_memory_settings(owner_user_id,enabled,revision,epoch,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(owner_user_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,epoch=excluded.epoch,updated_at=excluded.updated_at`)
    .run(ownerUserId, enabled ? 1 : 0, revision, epoch, now());
}

function bump(ownerUserId: string): { enabled: boolean; revision: number; epoch: number } {
  const state = stateFor(ownerUserId);
  const next = { ...state, revision: state.revision + 1, epoch: state.epoch + 1 };
  saveState(ownerUserId, next.enabled, next.revision, next.epoch);
  return next;
}

export function getPrivateMemory(ownerUserId: string): PrivateMemoryView {
  const state = stateFor(ownerUserId);
  return { enabled: state.enabled, revision: state.revision, items: listCurrent(ownerUserId), pendingCorrections: listPendingCorrections(ownerUserId) };
}

interface ParsedNaturalCorrection { topic: string; measure: "迟到" | "等待" | "等候" | "等"; oldMinutes: number; newMinutes: number; clarifiesPending?: boolean; }
function parseNaturalMinutes(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, current = 0;
  for (const char of value) {
    if (char in digits) { current = digits[char]!; continue; }
    if (char === "十") { total += (current || 1) * 10; current = 0; continue; }
    if (char === "百") { total += (current || 1) * 100; current = 0; continue; }
    return null;
  }
  return total + current || null;
}
function minuteNumberPattern(value: number): string {
  const digit = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isInteger(value) || value <= 0 || value > 999) return String(value);
  if (value < 10) return `(?:${value}|${digit[value]})`;
  let rest = value, chinese = "";
  if (rest >= 100) { const hundreds = Math.floor(rest / 100); chinese += `${digit[hundreds]}百`; rest %= 100; }
  if (rest >= 10) { const tens = Math.floor(rest / 10); chinese += `${tens === 1 && !chinese ? "" : digit[tens]}十`; rest %= 10; }
  if (rest) chinese += digit[rest];
  return `(?:${value}|${chinese})`;
}
function parseNaturalMinuteCorrection(content: string): ParsedNaturalCorrection | null {
  const text = content.trim();
  if (/[“「『‘"'][^”」』’"']*[”」』’"']/.test(text) || /如果|假如|假设|可能|也许|或许|听说|据说|转述|引用/.test(text)) return null;
  const linkedPrefix = /^(?:刚才|刚刚|前面)(?:(?:那句)?(?:说|提到))?(?:的)?(?:变化|更正|纠正)(?:是指|指的是|就是)/u.exec(text);
  const correctionText = linkedPrefix ? text.slice(linkedPrefix[0].length).trim() : text;
  const match = /^(?:我|本人)之前关于([\u3400-\u9fffA-Za-z0-9]{1,12}?)(?:安排)?的(迟到|等待|等候|等)(?:时间|时长)(?:说错了|记错了|弄错了|不对)[，,:：]?\s*不是\s*([零〇一二两三四五六七八九十百\d]+)\s*分钟[，,]?\s*是\s*([零〇一二两三四五六七八九十百\d]+)\s*分钟(?:[；;，,。]\s*(?:原因(?:仍|还)?(?:未知|不清楚|不知道)|其他情况(?:先)?不(?:判断|推断)))*[。]?$/u.exec(correctionText);
  if (!match) return null;
  const oldMinutes = parseNaturalMinutes(match[3]!);
  const newMinutes = parseNaturalMinutes(match[4]!);
  if (!oldMinutes || !newMinutes || oldMinutes === newMinutes) return null;
  return { topic: match[1]!, measure: match[2] as ParsedNaturalCorrection["measure"], oldMinutes, newMinutes, ...(linkedPrefix ? { clarifiesPending: true } : {}) };
}
function isAmbiguousNaturalChange(content: string): boolean {
  const text = content.trim();
  if (/[“「『‘"'][^”」』’"']*[”」』’"']/.test(text) || /如果|假如|假设|可能|也许|或许|听说|据说|转述|引用|伴侣说|对方说|他说|她说/.test(text)) return false;
  if (/[？?]/.test(text)
    || /^(?:(?:我|本人)?(?:是不是|是否)|(?:我|本人)(?:之前)?(?:是不是|是否))\s*.{0,20}(?:说错|记错|弄错|更正|纠正)/u.test(text)
    || /(?:说错|记错|弄错|更正|纠正)(?:了)?(?:吗|么)$/u.test(text)
    || /(?:没有|没|并未|并非|不是|不曾|从未|不觉得|没觉得)\s*(?:说错|记错|弄错|更正|纠正|变了)/u.test(text)
    || /(?:他|她|伴侣|对方|朋友)(?:之前|刚才|刚刚)?(?:说|提到)/u.test(text)) return false;
  return /(?:之前|刚才|刚刚|前面).{0,24}(?:说错了|记错了|弄错了|更正|纠正)|(?:已经|都|确实)?变了|不一样了|不对了/u.test(text);
}
function explicitTopicArrangementChange(content: string): string | null {
  const match = /^(?:我|本人)之前关于([\u3400-\u9fffA-Za-z0-9]{1,12}?)安排的情况(?:已经|确实|都)?变了[。！!]?$/u.exec(content.trim());
  return match?.[1] ?? null;
}
function rawSourceMatchesOldFact(text: string, correction: ParsedNaturalCorrection, exactValue: boolean): boolean {
  if (/[“「『‘"'][^”」』’"']*[”」』’"']/.test(text) || /如果|假如|假设|可能|也许|或许|听说|据说|朋友说|对方说|伴侣说|他说|她说|助手|笔记|不知道是否|不确定是否|是否属实/.test(text)) return false;
  return factClusterCount(text, correction, exactValue) === 1;
}
function factClusterCount(text: string, correction: ParsedNaturalCorrection, exactValue: boolean): number {
  const clusters = new Set<string>();
  const topicPattern = new RegExp(correction.topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const topicPositions = [...text.matchAll(topicPattern)].map(match => match.index ?? 0);
  const measurePattern = correction.measure === "迟到" ? /迟到|晚到|迟了|晚了/g : /等待|等候|等着|等了|等过|等/g;
  const measurePositions = [...text.matchAll(measurePattern)].map(match => match.index ?? 0);
  const numberPattern = /([零〇一二两三四五六七八九十百\d]+)\s*分钟/g;
  const numberMatches = [...text.matchAll(numberPattern)].filter(match => !exactValue || parseNaturalMinutes(match[1]!) === correction.oldMinutes);
  for (const number of numberMatches) {
    const numberAt = number.index ?? 0;
    for (const measureAt of measurePositions) for (const topicAt of topicPositions) {
      const start = Math.min(topicAt, measureAt, numberAt), end = Math.max(topicAt, measureAt, numberAt);
      if (end - start > 64 || Math.abs(numberAt - measureAt) > 20) continue;
      const bridge = text.slice(start, end);
      if ((bridge.match(/[。；;！？!?\n]/g) ?? []).length > 1) continue;
      const relation = text.slice(Math.max(0, measureAt - 22), numberAt + number[0].length);
      if (/(?:不是|并非|并没有|没有|没|从未|不曾|不确定|不知道)[^，,。；;！？!?\n]{0,16}(?:迟到|晚到|迟了|晚了|等待|等候|等着|等了|等过)/u.test(relation)) continue;
      if (/(?:路程|车程|公交|地铁|开车|步行|距离)[^，,。；;！？!?\n]{0,8}$/.test(text.slice(Math.max(0, numberAt - 24), numberAt))) continue;
      clusters.add(`${topicAt}:${measureAt}:${numberAt}`);
    }
  }
  return clusters.size;
}
function oldFactRows(ownerUserId: string, correction: ParsedNaturalCorrection, exactValue: boolean): ItemRow[] {
  // An explicit correction may refer to an earlier message in this same conversation.
  // The source-message matcher below still requires one unique, current affirmed fact.
  const rows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=?
    AND (status='current' OR (status='needs_clarification' AND correction_metadata LIKE '%pending_correction_candidate%'))`).all(ownerUserId) as ItemRow[];
  return rows.filter(row => {
    if (!sourcesStillCurrent(row)) return false;
    try {
      const ids = JSON.parse(row.source_message_ids) as string[];
      const sources = db.prepare(`SELECT m.content FROM private_messages m JOIN private_conversations c ON c.id=m.conversation_id
        WHERE c.owner_user_id=? AND c.id=? AND c.status='active' AND m.role='user' AND m.status='current'
        AND m.id IN (${ids.map(() => "?").join(",")})`)
        .all(ownerUserId, row.source_conversation_id, ...ids) as { content: string }[];
      const rawClusterCount = sources.reduce((count, source) => count + (rawSourceMatchesOldFact(source.content, correction, exactValue) ? 1 : 0), 0);
      const measure = correction.measure === "迟到" ? "(?:迟到|晚到|迟了|晚了)" : "(?:等待|等候|等着|等了|等过|等)";
      const numberWords = minuteNumberPattern(correction.oldMinutes);
      const noteMatches = row.kind === "user_statement" && new RegExp(`(?:${measure}[^。；;！？!?]{0,18}${numberWords}\\s*分钟|${numberWords}\\s*分钟[^。；;！？!?]{0,18}${measure})`).test(row.content);
      return rawClusterCount === 1 && (!exactValue || noteMatches);
    } catch { return false; }
  });
}
function containsOldMinuteDuration(content: string, correction: ParsedNaturalCorrection): boolean {
  const measure = correction.measure === "迟到" ? "(?:迟到|晚到|迟了|晚了)" : "(?:等待|等候|等着|等了|等过|等)";
  const number = minuteNumberPattern(correction.oldMinutes);
  // Notes may abbreviate a previously explicit duration by omitting its unit.
  // Keep those same-source old numeric assertions out of preserved siblings too.
  return new RegExp(`(?:${measure}[^。；;！？!?]{0,18}${number}|${number}[^。；;！？!?]{0,18}${measure})`, "u").test(content);
}
function nonConflictingCorrectionContext(content: string, correction: ParsedNaturalCorrection): string {
  const clauses = content.split(/(?<=[，,；;。！？!?\n])/u).map(clause => clause.trim()).filter(Boolean);
  const retained: string[] = [];
  const oldNumber = minuteNumberPattern(correction.oldMinutes);
  const oldLateDuration = correction.measure === "迟到"
    ? new RegExp(`^((?:用户的伴侣|伴侣|对方|用户|我)(?:晚到|迟到|晚了|迟了)(?:了)?)\\s*${oldNumber}\\s*分钟([。.!！；;]?)$`, "u")
    : null;
  for (const clause of clauses) {
    const actorAction = oldLateDuration?.exec(clause);
    if (actorAction) {
      // Preserve only the explicit actor/action prefix; the superseded duration
      // itself is never copied or rewritten into the new context item.
      retained.push(`${actorAction[1]}${actorAction[2].replace(/[；;]/u, "")}`);
      continue;
    }
    const containsNumericDuration = /[零〇一二两三四五六七八九十百千万\d]+\s*(?:分钟|小时|天|周|个月|年|次|公里|米|元)/u.test(clause);
    const containsCorrectionNumber = /(?:不是|改为|改成|更正为|纠正为|说错了|记错了)[^；;。！？!?\n]{0,24}[零〇一二两三四五六七八九十百千万\d]+/u.test(clause);
    if (/[\d]/u.test(clause) || new RegExp(oldNumber, "u").test(clause) || containsNumericDuration || containsCorrectionNumber) continue;
    retained.push(clause);
  }
  return formatDerivedContext(retained.join("；"));
}
function potentialOldFactRows(ownerUserId: string, correction: ParsedNaturalCorrection, sourceConversationId: string): ItemRow[] {
  const rows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND source_conversation_id<>?
    AND (status='current' OR (status='needs_clarification' AND correction_metadata LIKE '%pending_correction_candidate%'))`).all(ownerUserId, sourceConversationId) as ItemRow[];
  return rows.filter(row => {
    if (row.kind !== "user_statement" || !sourcesStillCurrent(row)) return false;
    const measure = correction.measure === "迟到" ? /迟到|晚到|迟了|晚了/ : /等待|等候|等着|等了|等过/;
    const old = new RegExp(`${minuteNumberPattern(correction.oldMinutes)}\\s*分钟`);
    if (!measure.test(row.content) || !old.test(row.content)) return false;
    try {
      const ids = JSON.parse(row.source_message_ids) as string[];
      const texts = db.prepare(`SELECT content FROM private_messages WHERE id IN (${ids.map(() => "?").join(",")}) AND role='user' AND status='current'`).all(...ids) as { content: string }[];
      // This broad source hit only quarantines a candidate for clarification;
      // the stricter affirmed-event matcher above is still required to apply.
      return texts.some(({content}) => content.includes(correction.topic) && measure.test(content) && old.test(content));
    } catch { return false; }
  });
}
function sourceHasCompetingEvents(row: ItemRow, correction: ParsedNaturalCorrection): boolean {
  try {
    const ids = JSON.parse(row.source_message_ids) as string[];
    const sources = db.prepare(`SELECT content FROM private_messages WHERE id IN (${ids.map(() => "?").join(",")}) AND role='user' AND status='current'`).all(...ids) as {content:string}[];
    return sources.some(source => rawSourceMatchesOldFact(source.content, correction, false) === false
      && factClusterCount(source.content, correction, false) > 1);
  } catch { return true; }
}
function uniqueTopicArrangementCandidates(ownerUserId: string, topic: string): ItemRow[] {
  const rows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND status='current' AND kind='user_statement'`).all(ownerUserId) as ItemRow[];
  const candidates = rows.filter(row => {
    if (!sourcesStillCurrent(row)) return false;
    try {
      const ids = JSON.parse(row.source_message_ids) as string[];
      if (!ids.length) return false;
      const sources = db.prepare(`SELECT content FROM private_messages WHERE id IN (${ids.map(() => "?").join(",")}) AND role='user' AND status='current'`).all(...ids) as {content:string}[];
      return sources.some(({content}) => content.includes(topic) && /安排|约好|约定|计划|打算|见面|看电影|散步|吃饭|晚饭|约会/u.test(content)
        && !/[“「『‘"'][^”」』’"']*[”」』’"']/.test(content)
        && !/听说|据说|朋友说|对方说|伴侣说|他说|她说/u.test(content));
    } catch { return false; }
  });
  return new Set(candidates.map(row => row.source_fingerprint)).size === 1 ? candidates : [];
}
function pendingCorrection(ownerUserId: string, sourceConversationId: string, messageId: string, messageVersion: number, content: string, reason: PendingMemoryCorrection["reason"], candidates: ItemRow[], correction?: ParsedNaturalCorrection, scopeTopic?: string): void {
  const pendingId = crypto.randomUUID();
  const candidateMemoryItemIds = candidates.map(candidate => candidate.id);
  for (const candidate of candidates) {
    db.prepare(`UPDATE private_memory_items SET status='needs_clarification',correction_metadata=?,version=version+1,updated_at=? WHERE id=? AND status IN ('current','needs_clarification')`)
      .run(JSON.stringify({ type: "pending_correction_candidate", pendingCorrectionId: pendingId }), now(), candidate.id);
  }
  const sourceIds = [messageId], versions = { [messageId]: messageVersion }, timestamp = now();
  db.prepare(`INSERT INTO private_memory_items(id,owner_user_id,kind,content,version,source_conversation_id,source_note_id,source_message_ids,source_message_versions,source_fingerprint,correction,correction_metadata,locked,status,created_at,updated_at)
    VALUES(?,?, 'unknown', ?,1,?,?,?,?,?,NULL,?,1,'needs_clarification',?,?)`)
    .run(pendingId, ownerUserId, content, sourceConversationId, `natural-correction-pending:${messageId}`, JSON.stringify(sourceIds), JSON.stringify(versions), fingerprint(sourceIds, versions),
      JSON.stringify({ type: "natural_correction_pending", reason, candidateMemoryItemIds,
        ...(scopeTopic && candidates.length ? { scopeTopic, candidateSourceFingerprints: [...new Set(candidates.map(candidate => candidate.source_fingerprint))] } : {}),
        ...(correction ? { correction } : {}) }), timestamp, timestamp);
  bump(ownerUserId);
}

/** Applies only an explicit, numeric minute correction uniquely grounded in this owner's current source text. */
export function applyNaturalMemoryCorrection(ownerUserId: string, sourceConversationId: string, messageId: string, messageVersion: number, content: string): void {
  if (!stateFor(ownerUserId).enabled) return;
  const parsed = parseNaturalMinuteCorrection(content);
  if (!parsed) {
    if (isAmbiguousNaturalChange(content)) {
      const topic = explicitTopicArrangementChange(content);
      const candidates = topic ? uniqueTopicArrangementCandidates(ownerUserId, topic) : [];
      pendingCorrection(ownerUserId, sourceConversationId, messageId, messageVersion, content, "ambiguous_change", candidates, undefined, topic ?? undefined);
    }
    return;
  }
  const related = oldFactRows(ownerUserId, parsed, false);
  const exact = oldFactRows(ownerUserId, parsed, true);
  const potential = potentialOldFactRows(ownerUserId, parsed, sourceConversationId);
  const candidates = related.length ? related : potential;
  const relatedFingerprints = new Set(candidates.map(row => row.source_fingerprint));
  const exactFingerprints = new Set(exact.map(row => row.source_fingerprint));
  const competingEvents = candidates.some(row => sourceHasCompetingEvents(row, parsed));
  if (exactFingerprints.size !== 1 || relatedFingerprints.size > 1 || competingEvents) {
    pendingCorrection(ownerUserId, sourceConversationId, messageId, messageVersion, content, exactFingerprints.size || relatedFingerprints.size > 1 ? "ambiguous_target" : "no_target", candidates, parsed);
    return;
  }
  const target = exact[0]!;
  let targetIds: string[], targetVersions: Record<string, number>;
  try { targetIds = JSON.parse(target.source_message_ids) as string[]; targetVersions = JSON.parse(target.source_message_versions) as Record<string, number>; }
  catch { pendingCorrection(ownerUserId, sourceConversationId, messageId, messageVersion, content, "no_target", [target]); return; }
  const affected = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND (status='current' OR (status='needs_clarification' AND correction_metadata LIKE '%pending_correction_candidate%'))`).all(ownerUserId) as ItemRow[];
  // Also retire tentative/unknown notes using the superseded duration.
  const exactConflictIds = new Set(affected.filter(row => containsOldMinuteDuration(row.content, parsed)).map(row => row.id));
  const sharesTargetSource = (row: ItemRow): boolean => {
    try {
      const ids = JSON.parse(row.source_message_ids) as string[];
      const versions = JSON.parse(row.source_message_versions) as Record<string, number>;
      return targetIds.some(id => ids.includes(id) && versions[id] === targetVersions[id]);
    } catch { return false; }
  };
  const hasTargetQuarantine = affected.some(row => row.status === "needs_clarification" && sourcesStillCurrent(row) && sharesTargetSource(row));
  let superseded = affected.filter(row => {
    if (!sourcesStillCurrent(row)) return false;
    if (!sharesTargetSource(row)) return false;
    // Explicit numeric corrections supersede only notes that actually assert
    // the old value. Quarantined candidates keep conservative source invalidation.
    return row.status === "needs_clarification" || hasTargetQuarantine || exactConflictIds.has(row.id);
  });
  const supersededIds = new Set(superseded.map(row => row.id));
  const pendingRows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND status='needs_clarification'`).all(ownerUserId) as ItemRow[];
  const localAmbiguous = pendingRows.filter(row => {
    if (row.source_conversation_id !== sourceConversationId) return false;
    try { return JSON.parse(row.correction_metadata ?? "{}").type === "natural_correction_pending"
      && JSON.parse(row.correction_metadata ?? "{}").reason === "ambiguous_change"; }
    catch { return false; }
  });
  const currentCorrectionRow = db.prepare(`SELECT rowid FROM private_messages WHERE id=? AND conversation_id=? AND status='current'`).get(messageId, sourceConversationId) as {rowid:number}|undefined;
  const precedingAmbiguous = localAmbiguous.flatMap(row => {
    try {
      const pendingId = (JSON.parse(row.source_message_ids) as string[])[0];
      const source = db.prepare(`SELECT rowid FROM private_messages WHERE id=? AND conversation_id=? AND role='user' AND status='current'`).get(pendingId, sourceConversationId) as {rowid:number}|undefined;
      return currentCorrectionRow && source && source.rowid < currentCorrectionRow.rowid ? [{id:row.id,rowid:source.rowid}] : [];
    } catch { return []; }
  }).sort((a,b) => b.rowid-a.rowid);
  const explicitlyLinkedPendingId = parsed.clarifiesPending ? precedingAmbiguous[0]?.id : undefined;
  const tiedAmbiguousIds = new Set(localAmbiguous.filter(row => {
    try {
      const precedes = precedingAmbiguous.some(item => item.id === row.id);
      return precedes && explicitlyLinkedPendingId === row.id;
    } catch { return false; }
  }).map(row => row.id));
  const pendingEvents = pendingRows.filter(row => {
    try {
      const metadata = row.correction_metadata ? JSON.parse(row.correction_metadata) as { type?: string; reason?: string; candidateMemoryItemIds?: string[]; scopeTopic?: string; candidateSourceFingerprints?: string[] } : {};
      const linkedCandidates = (metadata.candidateMemoryItemIds ?? []).some(id => supersededIds.has(id));
      const sourceBoundTopic = metadata.reason === "ambiguous_change" && metadata.scopeTopic === parsed.topic
        && (metadata.candidateSourceFingerprints ?? []).includes(target.source_fingerprint);
      return metadata.type === "natural_correction_pending" && (linkedCandidates || sourceBoundTopic || tiedAmbiguousIds.has(row.id));
    } catch { return false; }
  });
  // Any unresolved same-source candidate or associated pending event keeps the
  // old full-source quarantine. Preserve sibling notes only for a clean, uniquely
  // grounded exact numeric correction.
  const preserveSiblingFacts = !hasTargetQuarantine && pendingEvents.length === 0;
  if (!preserveSiblingFacts) {
    const supersededIdsNow = new Set(superseded.map(row => row.id));
    superseded = [...superseded, ...affected.filter(row => row.status === "current" && sharesTargetSource(row) && !supersededIdsNow.has(row.id))];
  }
  const preservedSiblings = preserveSiblingFacts ? affected.filter(row => row.status === "current" && !exactConflictIds.has(row.id)
    && sourcesStillCurrent(row) && sharesTargetSource(row)) : [];
  for (const row of preservedSiblings) db.prepare(`UPDATE private_memory_items SET locked=1,version=version+1,updated_at=? WHERE id=? AND status='current'`)
    .run(now(), row.id);
  const contextDerivations = preserveSiblingFacts ? superseded
    .filter(row => row.status === "current" && exactConflictIds.has(row.id) && row.kind === "user_statement")
    .flatMap(row => {
      const content = nonConflictingCorrectionContext(row.content, parsed);
      return content ? [{ row, content }] : [];
    }) : [];
  const supersedes = superseded.map(row => ({
    memoryItemId: row.id, itemVersion: row.version, sourceConversationId: row.source_conversation_id,
    sourceMessageIds: JSON.parse(row.source_message_ids) as string[],
    sourceMessageVersions: JSON.parse(row.source_message_versions) as Record<string, number>,
  }));
  const pendingEchoes = affected.filter(row => row.status === "current" && pendingEvents.some(pending => {
    try {
      const pendingIds = JSON.parse(pending.source_message_ids) as string[];
      const pendingVersions = JSON.parse(pending.source_message_versions) as Record<string, number>;
      const ids = JSON.parse(row.source_message_ids) as string[];
      const versions = JSON.parse(row.source_message_versions) as Record<string, number>;
      return pendingIds.some(id => ids.includes(id) && pendingVersions[id] === versions[id]);
    } catch { return false; }
  }) && !superseded.some(item => item.id === row.id));
  for (const row of pendingEchoes) supersedes.push({
    memoryItemId: row.id, itemVersion: row.version, sourceConversationId: row.source_conversation_id,
    sourceMessageIds: JSON.parse(row.source_message_ids) as string[],
    sourceMessageVersions: JSON.parse(row.source_message_versions) as Record<string, number>,
  });
  for (const row of pendingEvents) supersedes.push({
    memoryItemId: row.id, itemVersion: row.version, sourceConversationId: row.source_conversation_id,
    sourceMessageIds: JSON.parse(row.source_message_ids) as string[],
    sourceMessageVersions: JSON.parse(row.source_message_versions) as Record<string, number>,
  });
  const timestamp = now();
  for (const sourceMessageId of targetIds) db.prepare(`INSERT INTO private_memory_cutoff_sources(owner_user_id,source_message_id,source_message_version,superseded_by_message_id,superseded_by_message_version) VALUES(?,?,?,?,?)
    ON CONFLICT(owner_user_id,source_message_id) DO UPDATE SET source_message_version=excluded.source_message_version,
      superseded_by_message_id=excluded.superseded_by_message_id,superseded_by_message_version=excluded.superseded_by_message_version`)
    .run(ownerUserId, sourceMessageId, targetVersions[sourceMessageId], messageId, messageVersion);
  for (const row of [...superseded, ...pendingEchoes]) {
    db.prepare(`INSERT OR IGNORE INTO private_memory_tombstones(owner_user_id,source_fingerprint,created_at) VALUES(?,?,?)`).run(ownerUserId, row.source_fingerprint, timestamp);
    db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,correction_metadata=NULL,source_message_ids='[]',source_message_versions='{}',status='superseded',locked=1,version=version+1,updated_at=? WHERE id=?`)
      .run(timestamp, row.id);
  }
  for (const { row, content } of contextDerivations) {
    const sourceMessageIds = JSON.parse(row.source_message_ids) as string[];
    const sourceMessageVersions = JSON.parse(row.source_message_versions) as Record<string, number>;
    const lineage = {
      memoryItemId: row.id, itemVersion: row.version, sourceConversationId: row.source_conversation_id,
      sourceMessageIds, sourceMessageVersions,
    };
    db.prepare(`INSERT INTO private_memory_items(id,owner_user_id,kind,content,version,source_conversation_id,source_note_id,source_message_ids,source_message_versions,source_fingerprint,correction,correction_metadata,locked,status,created_at,updated_at)
      VALUES(?,?, 'user_statement', ?,1,?,?,?,?,?,NULL,?,1,'current',?,?)`)
      .run(crypto.randomUUID(), ownerUserId, content, row.source_conversation_id, `natural-correction-context:${messageId}:${row.id}:${crypto.randomUUID()}`,
        JSON.stringify(sourceMessageIds), JSON.stringify(sourceMessageVersions), fingerprint(sourceMessageIds, sourceMessageVersions),
        JSON.stringify({ type: "natural_correction_context", appliedByMessageId: messageId, appliedByMessageVersion: messageVersion,
          fromMemoryId: row.id, fromMemoryVersion: row.version, supersedes: [lineage] }), timestamp, timestamp);
  }
  for (const row of pendingEvents) {
    try {
      const ids = JSON.parse(row.source_message_ids) as string[];
      const versions = JSON.parse(row.source_message_versions) as Record<string, number>;
      for (const id of ids) db.prepare(`INSERT INTO private_memory_cutoff_sources(owner_user_id,source_message_id,source_message_version) VALUES(?,?,?)
        ON CONFLICT(owner_user_id,source_message_id) DO UPDATE SET source_message_version=excluded.source_message_version,
          superseded_by_message_id=NULL,superseded_by_message_version=NULL`).run(ownerUserId, id, versions[id]);
    } catch { /* malformed pending provenance cannot be restored as a note */ }
    db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,correction_metadata=NULL,source_message_ids='[]',source_message_versions='{}',status='resolved',locked=1,version=version+1,updated_at=? WHERE id=?`)
      .run(timestamp, row.id);
  }
  const newIds = [messageId], newVersions = { [messageId]: messageVersion };
  db.prepare(`INSERT INTO private_memory_items(id,owner_user_id,kind,content,version,source_conversation_id,source_note_id,source_message_ids,source_message_versions,source_fingerprint,correction,correction_metadata,locked,status,created_at,updated_at)
    VALUES(?,?, 'user_statement', ?,1,?,?,?,?,?,?,?,1,'current',?,?)`)
    .run(crypto.randomUUID(), ownerUserId, content, sourceConversationId, `natural-correction:${messageId}`, JSON.stringify(newIds), JSON.stringify(newVersions), fingerprint(newIds, newVersions), content,
      JSON.stringify({ type: "natural_correction_applied", supersedes, correction: parsed }), timestamp, timestamp);
  bump(ownerUserId);
}

export function updatePrivateMemorySettings(ownerUserId: string, enabled: boolean, expectedRevision: number) {
  return db.transaction(() => {
    const state = stateFor(ownerUserId);
    if (state.revision !== expectedRevision) return { error: "STALE_VERSION" as const };
    if (state.enabled !== enabled) {
      saveState(ownerUserId, enabled, state.revision + 1, state.epoch + 1);
      if (enabled) {
        const conversations = db.prepare(`SELECT id FROM private_conversations WHERE owner_user_id=? AND status='active'`).all(ownerUserId) as { id: string }[];
        for (const { id: conversationId } of conversations) {
          const notes = db.prepare(`SELECT id,kind,content,correction,source_message_ids AS sourceMessageIds,source_message_versions AS sourceMessageVersions,status,version
            FROM private_notes WHERE conversation_id=? AND status IN ('current','corrected')`).all(conversationId) as Array<{ id: string; kind: PrivateMemoryKind; content: string; correction: string | null; sourceMessageIds: string; sourceMessageVersions: string; status: string; version: number }>;
          syncPrivateMemoryFromNotes(ownerUserId, conversationId, notes);
        }
      }
    }
    else if (!db.prepare(`SELECT 1 FROM private_memory_settings WHERE owner_user_id=?`).get(ownerUserId)) saveState(ownerUserId, false, 1, 1);
    return { view: getPrivateMemory(ownerUserId) };
  }).immediate();
}

export function correctPrivateMemoryItem(ownerUserId: string, itemId: string, content: string, expectedVersion: number, expectedRevision: number) {
  return db.transaction(() => {
    const state = stateFor(ownerUserId);
    if (state.revision !== expectedRevision) return { error: "STALE_VERSION" as const };
    const row = db.prepare(`SELECT * FROM private_memory_items WHERE id=? AND owner_user_id=?`).get(itemId, ownerUserId) as ItemRow | undefined;
    if (!row) return { error: "NOT_FOUND" as const };
    if (row.status !== "current" || !sourcesStillCurrent(row) || row.version !== expectedVersion) return { error: "STALE_VERSION" as const };
    const correction = content.trim();
    if (!correction) return { error: "INVALID_CONTENT" as const };
    const sourceIds = JSON.parse(row.source_message_ids) as string[];
    const sourceVersions = JSON.parse(row.source_message_versions) as Record<string, number>;
    db.prepare(`UPDATE private_memory_items SET kind='user_statement',content=?,correction=?,locked=1,version=version+1,updated_at=? WHERE id=? AND version=? AND status='current'`)
      .run(correction, correction, now(), itemId, expectedVersion);
    const siblings = db.prepare(`SELECT id,source_message_ids,source_message_versions FROM private_memory_items
      WHERE owner_user_id=? AND source_conversation_id=? AND status='current' AND locked=0 AND id<>?`)
      .all(ownerUserId, row.source_conversation_id, itemId) as Array<{ id: string; source_message_ids: string; source_message_versions: string }>;
    const siblingIds = siblings.filter(item => {
      try {
        const ids = JSON.parse(item.source_message_ids) as string[];
        const versions = JSON.parse(item.source_message_versions) as Record<string, number>;
        return sourceIds.some(id => ids.includes(id) && versions[id] === sourceVersions[id]);
      } catch { return false; }
    }).map(item => item.id);
    if (siblingIds.length) db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,source_message_ids='[]',source_message_versions='{}',status='stale',version=version+1,updated_at=? WHERE id IN (${siblingIds.map(() => "?").join(",")})`)
      .run(now(), ...siblingIds);
    bump(ownerUserId);
    return { view: getPrivateMemory(ownerUserId) };
  }).immediate();
}

export function forgetPrivateMemoryItem(ownerUserId: string, itemId: string, expectedVersion: number, expectedRevision: number) {
  return db.transaction(() => {
    const state = stateFor(ownerUserId);
    if (state.revision !== expectedRevision) return { error: "STALE_VERSION" as const };
    const row = db.prepare(`SELECT * FROM private_memory_items WHERE id=? AND owner_user_id=?`).get(itemId, ownerUserId) as ItemRow | undefined;
    if (!row) return { error: "NOT_FOUND" as const };
    if (!(row.status === "current" || row.status === "needs_clarification") || !sourcesStillCurrent(row) || row.version !== expectedVersion) return { error: "STALE_VERSION" as const };
    const sourceIds = JSON.parse(row.source_message_ids) as string[];
    const sourceVersions = JSON.parse(row.source_message_versions) as Record<string, number>;
    for (const sourceMessageId of sourceIds) {
      db.prepare(`INSERT INTO private_memory_cutoff_sources(owner_user_id,source_message_id,source_message_version) VALUES(?,?,?)
        ON CONFLICT(owner_user_id,source_message_id) DO UPDATE SET source_message_version=excluded.source_message_version`)
        .run(ownerUserId, sourceMessageId, sourceVersions[sourceMessageId]);
    }
    let pendingCandidateRows: ItemRow[] = [];
    if (row.status === "needs_clarification") {
      try {
        const metadata = row.correction_metadata ? JSON.parse(row.correction_metadata) as { type?: string; candidateMemoryItemIds?: string[] } : {};
        if (metadata.type === "natural_correction_pending") pendingCandidateRows = (metadata.candidateMemoryItemIds ?? []).flatMap(id => {
          const candidate = db.prepare(`SELECT * FROM private_memory_items WHERE id=? AND owner_user_id=? AND status='needs_clarification'`).get(id, ownerUserId) as ItemRow | undefined;
          return candidate ? [candidate] : [];
        });
      } catch { pendingCandidateRows = []; }
    }
    const related = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND status='current' AND id<>?`).all(ownerUserId, itemId) as ItemRow[];
    const relatedIds = related.filter(item => {
      try {
        const ids = JSON.parse(item.source_message_ids) as string[];
        const versions = JSON.parse(item.source_message_versions) as Record<string, number>;
        return sourceIds.some(sourceId => ids.includes(sourceId) && versions[sourceId] === sourceVersions[sourceId]);
      } catch { return false; }
    }).map(item => item.id);
    if (relatedIds.length) db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,source_message_ids='[]',source_message_versions='{}',status='stale',version=version+1,updated_at=? WHERE id IN (${relatedIds.map(() => "?").join(",")})`)
      .run(now(), ...relatedIds);
    const timestamp = now();
    db.prepare(`INSERT OR IGNORE INTO private_memory_tombstones(owner_user_id,source_fingerprint,created_at) VALUES(?,?,?)`).run(ownerUserId, row.source_fingerprint, timestamp);
    const forgottenIds = [itemId, ...pendingCandidateRows.map(candidate => candidate.id)];
    for (const candidate of pendingCandidateRows) {
      try {
        const ids = JSON.parse(candidate.source_message_ids) as string[];
        const versions = JSON.parse(candidate.source_message_versions) as Record<string, number>;
        for (const id of ids) db.prepare(`INSERT INTO private_memory_cutoff_sources(owner_user_id,source_message_id,source_message_version) VALUES(?,?,?)
          ON CONFLICT(owner_user_id,source_message_id) DO UPDATE SET source_message_version=excluded.source_message_version`).run(ownerUserId, id, versions[id]);
        db.prepare(`INSERT OR IGNORE INTO private_memory_tombstones(owner_user_id,source_fingerprint,created_at) VALUES(?,?,?)`).run(ownerUserId, candidate.source_fingerprint, timestamp);
      } catch { /* malformed source metadata cannot restore forgotten content */ }
    }
    db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,correction_metadata=NULL,source_message_ids='[]',source_message_versions='{}',status='forgotten',locked=1,version=version+1,updated_at=? WHERE id IN (${forgottenIds.map(() => "?").join(",")})`)
      .run(timestamp, ...forgottenIds);
    bump(ownerUserId);
    return { view: getPrivateMemory(ownerUserId) };
  }).immediate();
}

export function clearPrivateMemory(ownerUserId: string, expectedRevision: number) {
  return db.transaction(() => {
    const state = stateFor(ownerUserId);
    if (state.revision !== expectedRevision) return { error: "STALE_VERSION" as const };
    const timestamp = now();
    const sources = db.prepare(`SELECT m.id,m.version FROM private_messages m JOIN private_conversations c ON c.id=m.conversation_id
      WHERE c.owner_user_id=? AND c.status='active' AND m.role='user' AND m.status='current'`).all(ownerUserId) as { id: string; version: number }[];
    for (const source of sources) db.prepare(`INSERT INTO private_memory_cutoff_sources(owner_user_id,source_message_id,source_message_version) VALUES(?,?,?)
      ON CONFLICT(owner_user_id,source_message_id) DO UPDATE SET source_message_version=excluded.source_message_version`).run(ownerUserId, source.id, source.version);
    db.prepare(`INSERT OR IGNORE INTO private_memory_tombstones(owner_user_id,source_fingerprint,created_at)
      SELECT owner_user_id,source_fingerprint,? FROM private_memory_items WHERE owner_user_id=? AND status IN ('current','needs_clarification')`).run(timestamp, ownerUserId);
    db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,correction_metadata=NULL,source_message_ids='[]',source_message_versions='{}',status='forgotten',locked=1,version=version+1,updated_at=? WHERE owner_user_id=? AND status IN ('current','needs_clarification')`).run(timestamp, ownerUserId);
    bump(ownerUserId);
    return { view: getPrivateMemory(ownerUserId) };
  }).immediate();
}

function words(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const roleNeutralized = normalized.replace(/伴侣|对方|情侣|夫妻|妻子|丈夫|老公|老婆|男友|女友|男朋友|女朋友/g, " ");
  const tokens = new Set(roleNeutralized.match(/[a-z0-9]{2,}/g) ?? []);
  const chars = [...roleNeutralized.replace(/[^\u3400-\u9fff]/g, "")];
  for (let index = 0; index < chars.length - 1; index++) tokens.add(chars[index] + chars[index + 1]);
  for (const common of ["我说","觉得","现在","最近","这个","那个","可以","因为","所以","但是","如果","没有","不是","我们","对方","伴侣","情侣","夫妻","妻子","丈夫","老公","老婆","用户","关系","事情","时候","之后","然后","一个","一些","自己","真的","希望","已经","一直","可能","有点","怎么","什么","为什么"]) tokens.delete(common);
  return tokens;
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

export function getPrivateMemoryReplySnapshot(ownerUserId: string, currentMessage: string, excludeConversationId?: string, sourceMessageId?: string, recentUserMessages: string[] = []): MemoryReplySnapshot {
  const state = stateFor(ownerUserId);
  if (!state.enabled) return { enabled: false, epoch: state.epoch, items: [], pendingCorrections: [], knownCorrections: [] };
  const pendingCorrections = listPendingCorrections(ownerUserId).filter(item =>
    item.reason === "ambiguous_change"
      || (item.sourceConversationId === excludeConversationId && (!sourceMessageId || item.sourceMessageIds.includes(sourceMessageId)))
      || [...words(item.content ?? "")].some(word => words(currentMessage).has(word)));
  // An untargeted change cannot be safely mapped to a memory item, so keep all
  // prior memory out of this reply until the owner resolves or forgets it.
  if (pendingCorrections.some(item => item.reason === "ambiguous_change"))
    return { enabled: true, epoch: state.epoch, items: [], pendingCorrections, knownCorrections: [] };
  const currentRows = listCurrent(ownerUserId);
  const memorySuppressed = new Set<string>();
  for (const pending of pendingCorrections) {
    const pendingRow = db.prepare(`SELECT correction_metadata FROM private_memory_items WHERE id=? AND owner_user_id=? AND status='needs_clarification'`).get(pending.id, ownerUserId) as { correction_metadata: string | null } | undefined;
    try {
      const correction = pendingRow?.correction_metadata ? JSON.parse(pendingRow.correction_metadata).correction as ParsedNaturalCorrection | undefined : undefined;
      if (correction) for (const row of potentialOldFactRows(ownerUserId, correction, excludeConversationId ?? "")) memorySuppressed.add(row.id);
    } catch { /* malformed pending state cannot select Memory */ }
  }
  const knownCorrections: KnownMemoryCorrection[] = [];
  const scopedCorrectionItemIds = new Set<string>();
  for (const item of currentRows) {
    if (item.correctionStatus !== "applied") continue;
    const correctionSourceId = item.sourceMessageIds[0];
    const sourceMessageVersion = correctionSourceId ? item.sourceMessageVersions[correctionSourceId] : undefined;
    let meta: ParsedNaturalCorrection | null = null;
    const metadataRow = db.prepare(`SELECT correction_metadata FROM private_memory_items WHERE id=? AND owner_user_id=? AND status='current'`).get(item.id, ownerUserId) as { correction_metadata: string | null } | undefined;
    try { meta = metadataRow?.correction_metadata ? JSON.parse(metadataRow.correction_metadata).correction as ParsedNaturalCorrection : null; } catch { meta = null; }
    if (!meta || !correctionSourceId || !Number.isInteger(sourceMessageVersion)) continue;
    const currentTurnCorrection = correctionSourceId === sourceMessageId && item.sourceConversationId === excludeConversationId;
    const otherEvent = hasOtherExplicitEventTopic(currentMessage, meta.topic);
    const queryNamesTopic = currentMessage.includes(meta.topic) && !otherEvent;
    const anaphoricContinuation = /那次|那件事|这件事|接着|继续|之前说的|那个安排/u.test(currentMessage)
      && !otherEvent
      && recentUserMessages.slice(-2).some(text => text.includes(meta.topic));
    if (!memorySuppressed.has(item.id) && (currentTurnCorrection || queryNamesTopic || anaphoricContinuation)) {
      scopedCorrectionItemIds.add(item.id);
      knownCorrections.push({ ...meta, sourceConversationId: item.sourceConversationId, sourceMessageId: correctionSourceId, sourceMessageVersion: sourceMessageVersion! });
    }
  }
  // When the owner asks about a corrected event, reserve relevance for current
  // notes grounded in the exact source versions that the correction superseded.
  // This recovers low-overlap context (such as when/where) without reopening a
  // whole conversation or selecting stale, forgotten, or pending source notes.
  const correctedSourceVersions = new Set<string>();
  for (const item of currentRows) {
    if (!scopedCorrectionItemIds.has(item.id)) continue;
    for (const lineage of item.supersedes ?? []) {
      if (!lineage.sourceConversationId || !Array.isArray(lineage.sourceMessageIds)) continue;
      for (const id of lineage.sourceMessageIds) {
        const version = lineage.sourceMessageVersions?.[id];
        if (typeof id === "string" && Number.isInteger(version))
          correctedSourceVersions.add(`${lineage.sourceConversationId}:${id}:${version}`);
      }
    }
  }
  const query = words(currentMessage);
  const ranked = currentRows.filter(item => item.sourceConversationId !== excludeConversationId && !memorySuppressed.has(item.id)
    && (item.correctionStatus !== "applied" || scopedCorrectionItemIds.has(item.id))).map(item => {
    const itemWords = words(item.content);
    let score = 0;
    for (const term of itemWords) if (query.has(term)) score++;
    const correctedSourceCluster = item.sourceMessageIds.some(id =>
      correctedSourceVersions.has(`${item.sourceConversationId}:${id}:${item.sourceMessageVersions[id]}`));
    return { item, score, correctedSourceCluster };
  }).filter(entry => entry.score > 0 || entry.correctedSourceCluster)
    .sort((a, b) => Number(b.correctedSourceCluster) - Number(a.correctedSourceCluster)
      || b.score - a.score || b.item.updatedAt - a.item.updatedAt);
  const selected: PrivateMemoryItem[] = [];
  let length = 0;
  for (const { item } of ranked) {
    if (selected.length >= 5 || length + item.content.length > 1800) continue;
    selected.push(item); length += item.content.length;
  }
  const promptItems = selected.map(item => {
    const rows = db.prepare(`SELECT id,version,created_at FROM private_messages WHERE conversation_id=? AND role='user' AND status='current'
      AND id IN (${item.sourceMessageIds.map(() => "?").join(",")})`).all(item.sourceConversationId, ...item.sourceMessageIds) as Array<{ id: string; version: number; created_at: number }>;
    return { ...item, sourceMessageTimes: rows.map(source => ({ id: source.id, version: source.version, originalCreatedAtUtc: new Date(source.created_at).toISOString() })) };
  });
  return { enabled: true, epoch: state.epoch, items: promptItems, pendingCorrections, knownCorrections };
}

export function privateMemorySnapshotStillCurrent(ownerUserId: string, snapshot: MemoryReplySnapshot): boolean {
  const state = stateFor(ownerUserId);
  if (state.epoch !== snapshot.epoch || state.enabled !== snapshot.enabled) return false;
  if (!snapshot.enabled) return true;
  for (const item of snapshot.items) {
    const row = db.prepare(`SELECT * FROM private_memory_items WHERE id=? AND owner_user_id=? AND status='current' AND version=?`).get(item.id, ownerUserId, item.version) as ItemRow | undefined;
    if (!row || !sourcesStillCurrent(row)) return false;
    if (fingerprint(item.sourceMessageIds, item.sourceMessageVersions) !== row.source_fingerprint) return false;
  }
  for (const correction of snapshot.knownCorrections) {
    const source = db.prepare(`SELECT m.version FROM private_messages m JOIN private_conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND m.conversation_id=? AND m.role='user' AND m.status='current' AND m.version=? AND c.owner_user_id=? AND c.status='active'`)
      .get(correction.sourceMessageId, correction.sourceConversationId, correction.sourceMessageVersion, ownerUserId);
    const memory = db.prepare(`SELECT 1 FROM private_memory_items WHERE owner_user_id=? AND source_conversation_id=? AND status='current'
      AND source_message_ids LIKE ? AND correction_metadata LIKE '%natural_correction_applied%'`).get(ownerUserId, correction.sourceConversationId, `%${correction.sourceMessageId}%`);
    if (!source || !memory) return false;
  }
  return true;
}

/** Invalidates in-flight replies when another private source conversation changes. */
export function markPrivateMemorySourceChanged(ownerUserId: string): void {
  const state = stateFor(ownerUserId);
  if (!state.enabled) return;
  saveState(ownerUserId, true, state.revision, state.epoch + 1);
}

/** Called in the existing notes-job transaction; this adds no model stage or call. */
export function syncPrivateMemoryFromNotes(ownerUserId: string, conversationId: string, notes: Array<{ id: string; kind: PrivateMemoryKind; content: string; correction: string | null; sourceMessageIds: string; sourceMessageVersions: string; status: string; version: number }>): void {
  const state = stateFor(ownerUserId);
  if (!state.enabled) return;
  const timestamp = now();
  let changed = false;
  const pendingSources = activePendingSourceVersions(ownerUserId);
  if (pendingSources.size) {
    const currentRows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND status='current'`).all(ownerUserId) as ItemRow[];
    for (const row of currentRows) if (rowUsesPendingSource(row, pendingSources)) {
      db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,source_message_ids='[]',source_message_versions='{}',status='stale',locked=1,version=version+1,updated_at=? WHERE id=? AND status='current'`)
        .run(timestamp, row.id);
      changed = true;
    }
  }
  for (const note of notes) {
    if (!(["user_statement", "tentative_understanding", "unknown"] as string[]).includes(note.kind) || !["current", "corrected"].includes(note.status)) continue;
    let sourceIds: string[], versions: Record<string, number>;
    try { sourceIds = JSON.parse(note.sourceMessageIds); versions = JSON.parse(note.sourceMessageVersions); } catch { continue; }
    if (!sourceIds.length || sourceIds.some((id: string) => !Number.isInteger(versions[id]))) continue;
    const eligible = db.prepare(`SELECT m.id,m.version FROM private_messages m JOIN private_conversations c ON c.id=m.conversation_id
      WHERE c.id=? AND c.owner_user_id=? AND c.status='active' AND m.role='user' AND m.status='current' AND m.id IN (${sourceIds.map(() => "?").join(",")})`)
      .all(conversationId, ownerUserId, ...sourceIds) as { id: string; version: number }[];
    if (eligible.length !== sourceIds.length || eligible.some(source => source.version !== versions[source.id])) continue;
    if (sourceIds.some(id => pendingSources.has(`${id}:${versions[id]}`))) continue;
    const content = note.status === "corrected" && note.correction?.trim() ? note.correction.trim() : note.content.trim();
    if (!content) continue;
    // A notes response can cite an old protected source alongside an independent
    // new statement. Admit only an exact, whole-message restatement from a
    // current source that has never been cut off or locked; otherwise keep the
    // existing conservative protection. Memory provenance records only the
    // independent evidence, not the ignored protected citation.
    const corrections = db.prepare(`SELECT source_message_ids,source_message_versions FROM private_memory_items
      WHERE owner_user_id=? AND source_conversation_id=? AND status='current' AND locked=1`).all(ownerUserId, conversationId) as Array<{ source_message_ids: string; source_message_versions: string }>;
    const sourceIsLocked = (source: {id:string;version:number}) => corrections.some(row => {
      try { return (JSON.parse(row.source_message_ids) as string[]).includes(source.id)
        && JSON.parse(row.source_message_versions)[source.id] === source.version; }
      catch { return true; }
    });
    const independentSources = eligible.filter(source => {
      const raw = db.prepare(`SELECT content FROM private_messages WHERE id=?`).get(source.id) as {content:string};
      if (raw.content.trim() !== content) return false;
      if (db.prepare(`SELECT 1 FROM private_memory_cutoff_sources WHERE owner_user_id=? AND source_message_id=?`).get(ownerUserId, source.id)) return false;
      if (pendingSources.has(`${source.id}:${source.version}`)) return false;
      return !sourceIsLocked(source);
    });
    const originalFingerprint = fingerprint(sourceIds, versions);
    if (db.prepare(`SELECT 1 FROM private_memory_tombstones WHERE owner_user_id=? AND source_fingerprint=?`).get(ownerUserId, originalFingerprint)) continue;
    // Forgetting, clearing and natural supersession remain source-wide. Never
    // use a new citation to bypass those cutoff or tombstone decisions.
    const hasCutoffSource = eligible.some(source => db.prepare(`SELECT 1 FROM private_memory_cutoff_sources
      WHERE owner_user_id=? AND source_message_id=?`).get(ownerUserId, source.id));
    if (eligible.some(sourceIsLocked) && !hasCutoffSource && independentSources.length && independentSources.length < sourceIds.length) {
      sourceIds = independentSources.map(source => source.id);
      versions = Object.fromEntries(independentSources.map(source => [source.id, source.version]));
    }
    const memorySources = eligible.filter(source => sourceIds.includes(source.id));
    const beyondClear = memorySources.every(source => {
      const cutoff = db.prepare(`SELECT source_message_version,superseded_by_message_id,superseded_by_message_version FROM private_memory_cutoff_sources WHERE owner_user_id=? AND source_message_id=?`).get(ownerUserId, source.id) as { source_message_version: number; superseded_by_message_id: string | null; superseded_by_message_version: number | null } | undefined;
      if (!cutoff) return true;
      if (cutoff.source_message_version === source.version) return false;
      if (cutoff.superseded_by_message_id && cutoff.superseded_by_message_version !== null) {
        const activeCorrection = db.prepare(`SELECT 1 FROM private_messages m JOIN private_conversations c ON c.id=m.conversation_id
          WHERE m.id=? AND m.version=? AND m.role='user' AND m.status='current' AND c.owner_user_id=? AND c.status='active'`)
          .get(cutoff.superseded_by_message_id, cutoff.superseded_by_message_version, ownerUserId);
        if (activeCorrection) return false;
      }
      return true;
    });
    if (!beyondClear) continue;
    const blockedByPendingCorrection = sourceIds.some(id => pendingSources.has(`${id}:${versions[id]}`));
    if (blockedByPendingCorrection) continue;
    const fp = fingerprint(sourceIds, versions);
    if (db.prepare(`SELECT 1 FROM private_memory_tombstones WHERE owner_user_id=? AND source_fingerprint=?`).get(ownerUserId, fp)) continue;
    const existing = db.prepare(`SELECT id,version,content,kind,source_fingerprint,status,locked FROM private_memory_items WHERE owner_user_id=? AND source_note_id=?`).get(ownerUserId, note.id) as { id: string; version: number; content: string; kind: string; source_fingerprint: string; status: string; locked: number } | undefined;
    if (existing?.status === "forgotten") continue;
    if (existing?.status === "needs_clarification") continue;
    const correctedMemory = corrections.some(correction => {
      try {
        const correctedIds = JSON.parse(correction.source_message_ids) as string[];
        const correctedVersions = JSON.parse(correction.source_message_versions) as Record<string, number>;
        return correctedIds.some(id => sourceIds.includes(id) && versions[id] === correctedVersions[id]);
      } catch { return false; }
    });
    if (correctedMemory) continue;
    const kind = note.status === "corrected" ? "user_statement" : note.kind;
    if (existing?.locked) continue;
    if (existing && existing.status === "current" && existing.content === content && existing.kind === kind && existing.source_fingerprint === fp) continue;
    // Notes jobs replace their note rows. The same sourced fact is still the
    // same memory; point it at the current note so owner corrections still work.
    if (!existing) {
      const duplicate = db.prepare(`SELECT id FROM private_memory_items WHERE owner_user_id=? AND source_conversation_id=?
        AND status='current' AND locked=0 AND source_fingerprint=? AND kind=? AND content=? LIMIT 1`)
        .get(ownerUserId, conversationId, fp, kind, content) as { id: string } | undefined;
      if (duplicate) {
        db.prepare(`UPDATE private_memory_items SET source_note_id=?,version=version+1,updated_at=? WHERE id=?`)
          .run(note.id, timestamp, duplicate.id);
        changed = true;
        continue;
      }
    }
    if (existing) {
      db.prepare(`UPDATE private_memory_items SET kind=?,content=?,version=version+1,source_conversation_id=?,source_message_ids=?,source_message_versions=?,source_fingerprint=?,correction=?,locked=0,status='current',updated_at=? WHERE id=?`)
        .run(kind, content, conversationId, JSON.stringify(sourceIds), JSON.stringify(versions), fp, note.status === "corrected" ? content : null, timestamp, existing.id);
    } else {
      db.prepare(`INSERT INTO private_memory_items(id,owner_user_id,kind,content,version,source_conversation_id,source_note_id,source_message_ids,source_message_versions,source_fingerprint,correction,locked,status,created_at,updated_at)
        VALUES(?,?,?, ?,1,?,?,?,?,?,NULL,0,'current',?,?)`).run(crypto.randomUUID(), ownerUserId, kind, content, conversationId, note.id, JSON.stringify(sourceIds), JSON.stringify(versions), fp, timestamp, timestamp);
    }
    changed = true;
  }
  // Omission from one notes response is not forgetting. Explicit correction,
  // pending, tombstone and cutoff checks above remain authoritative; withdraw
  // other memories only when their original user source is no longer current.
  const currentRows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND source_conversation_id=?
    AND status='current' AND locked=0`).all(ownerUserId, conversationId) as ItemRow[];
  for (const row of currentRows) if (!sourcesStillCurrent(row)) {
    db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,source_message_ids='[]',source_message_versions='{}',status='stale',version=version+1,updated_at=? WHERE id=?`)
      .run(timestamp, row.id);
    changed = true;
  }
  if (changed) bump(ownerUserId);
}

export function syncCorrectedNoteToMemory(ownerUserId: string, noteId: string, correction: string): void {
  const row = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND source_note_id=?`).get(ownerUserId, noteId) as ItemRow | undefined;
  if (!row) return;
  // A numeric correction may have split safe context from this superseded note.
  // An explicit note correction withdraws that derived context as well. Do not
  // re-import the whole note or bypass the original source's numeric cutoff.
  const derived = (db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND status='current'
    AND correction_metadata LIKE '%natural_correction_context%'`).all(ownerUserId) as ItemRow[]).filter(item => {
    try {
      const metadata = JSON.parse(item.correction_metadata ?? "{}");
      return metadata.type === "natural_correction_context" && metadata.fromMemoryId === row.id;
    } catch { return false; }
  });
  for (const item of derived) db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,correction_metadata=NULL,
    source_message_ids='[]',source_message_versions='{}',status='stale',locked=1,version=version+1,updated_at=? WHERE id=? AND owner_user_id=?`)
    .run(now(), item.id, ownerUserId);
  const updateOriginal = row.status === "current" && sourcesStillCurrent(row);
  if (updateOriginal) db.prepare(`UPDATE private_memory_items SET kind='user_statement',content=?,correction=?,locked=1,version=version+1,updated_at=? WHERE id=?`)
    .run(correction, correction, now(), row.id);
  if (derived.length || updateOriginal) bump(ownerUserId);
}

export function invalidatePrivateMemorySource(ownerUserId: string, conversationId: string, sourceMessageId?: string): void {
  const rows = db.prepare(`SELECT * FROM private_memory_items WHERE owner_user_id=? AND source_conversation_id=? AND status IN ('current','needs_clarification')`).all(ownerUserId, conversationId) as ItemRow[];
  const invalidRows = rows.filter(row => {
    if (!sourceMessageId) return true;
    try { return (JSON.parse(row.source_message_ids) as string[]).includes(sourceMessageId); } catch { return true; }
  });
  const invalidIds = new Set(invalidRows.map(row => row.id));
  for (const row of invalidRows) {
    if (row.status !== "needs_clarification") continue;
    try {
      const metadata = row.correction_metadata ? JSON.parse(row.correction_metadata) as { type?: string; candidateMemoryItemIds?: string[] } : {};
      if (metadata.type === "natural_correction_pending") for (const id of metadata.candidateMemoryItemIds ?? []) {
        if (db.prepare(`SELECT 1 FROM private_memory_items WHERE id=? AND owner_user_id=? AND status='needs_clarification'`).get(id, ownerUserId)) invalidIds.add(id);
      }
    } catch { /* malformed metadata cannot keep correction text active */ }
  }
  if (!invalidIds.size) { markPrivateMemorySourceChanged(ownerUserId); return; }
  db.prepare(`UPDATE private_memory_items SET content='',correction=NULL,correction_metadata=NULL,source_message_ids='[]',source_message_versions='{}',status='stale',version=version+1,updated_at=? WHERE owner_user_id=? AND id IN (${[...invalidIds].map(() => "?").join(",")})`)
    .run(now(), ownerUserId, ...invalidIds);
  bump(ownerUserId);
}
