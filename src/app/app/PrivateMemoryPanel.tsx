"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  clearPrivateMemory,
  forgetPrivateMemoryItem,
  getPrivateMemory,
  updatePrivateMemoryItem,
  updatePrivateMemorySettings,
  type PrivateMemoryItem,
  type PrivateMemoryPendingCorrection,
  type PrivateMemorySource,
  type PrivateMemoryView,
} from "@/lib/api";
import styles from "./private.module.css";

type MemoryGroup = "user_statement" | "tentative_understanding" | "unknown";
type MemoryForgetTarget = { id: string; version: number; revision: number };

const groups: { kind: MemoryGroup; title: string }[] = [
  { kind: "user_statement", title: "本人陈述" },
  { kind: "tentative_understanding", title: "暂定理解" },
  { kind: "unknown", title: "尚未知晓" },
];

function isStale(result: { error?: string; status?: number }) {
  return result.error === "STALE_VERSION" || result.status === 409;
}

function SourceLinks({ source, label }: { source: PrivateMemorySource; label: string }) {
  if (!source.sourceConversationId) return <span>暂时无法定位原对话</span>;
  const messageIds = source.sourceMessageIds ?? [];
  if (messageIds.length === 0) {
    return <Link href={`/app/conversations/${encodeURIComponent(source.sourceConversationId)}`}>{label}</Link>;
  }
  return <>
    {messageIds.map((messageId, index) => <Link key={`${source.sourceConversationId}-${messageId}-${index}`} href={`/app/conversations/${encodeURIComponent(source.sourceConversationId)}#message-${encodeURIComponent(messageId)}`}>
      {label}{messageIds.length > 1 ? `（${index + 1}）` : ""}
    </Link>)}
  </>;
}

export default function PrivateMemoryPanel() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PrivateMemoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [forgetTarget, setForgetTarget] = useState<MemoryForgetTarget | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  const forgetLock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  async function reload() {
    const request = ++requestGeneration.current;
    setForgetTarget(null);
    setLoading(true);
    setError("");
    setStale(false);
    const result = await getPrivateMemory();
    if (!mounted.current || request !== requestGeneration.current) return;
    setLoading(false);
    if (result.error) {
      setError(result.error === "STALE_VERSION" ? "内容已更新，请重新读取后再继续。" : result.error);
      setStale(isStale(result));
      return;
    }
    setView(result);
    setEditingId(null);
  }

  function setOpenAndLoad(next: boolean) {
    setOpen(next);
    if (!next) setForgetTarget(null);
    if (next && !view) void reload();
  }

  async function acceptMutation(result: PrivateMemoryView) {
    if (result.error) {
      if (isStale(result)) {
        setForgetTarget(null);
        setStale(true);
        setError("内容已在别处更新。请重新读取，再继续修改。");
      } else {
        setError(result.error);
      }
      return false;
    }
    setView(result);
    setEditingId(null);
    setDraft("");
    setForgetTarget(null);
    setStale(false);
    setError("");
    return true;
  }

  async function saveSettings(enabled: boolean) {
    if (!view || busy) return;
    setBusy(true);
    setError("");
    const result = await updatePrivateMemorySettings(enabled, view.revision);
    await acceptMutation(result);
    setBusy(false);
  }

  async function saveItem(item: PrivateMemoryItem) {
    if (!view || busy) return;
    const content = draft.trim();
    if (!content) {
      setError("请先写下你希望保留的说法。");
      return;
    }
    setBusy(true);
    setError("");
    const result = await updatePrivateMemoryItem(item.id, content, item.version, view.revision);
    await acceptMutation(result);
    setBusy(false);
  }

  function requestForget(item: { id: string; version: number }) {
    if (!view || busy || stale) return;
    setEditingId(null);
    setDraft("");
    setError("");
    setForgetTarget({ id: item.id, version: item.version, revision: view.revision });
  }

  async function confirmForget(target: MemoryForgetTarget) {
    if (!view || busy || stale || forgetLock.current || !forgetTarget
      || forgetTarget.id !== target.id
      || forgetTarget.version !== target.version || forgetTarget.revision !== target.revision) return;
    const current = view.items.find((item) => item.id === target.id);
    if (!current || current.version !== target.version || view.revision !== target.revision) {
      setForgetTarget(null);
      setStale(true);
      setError("内容已更新，已取消这次遗忘。请重新读取后再继续。");
      return;
    }
    forgetLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await forgetPrivateMemoryItem(target.id, target.version, target.revision);
      await acceptMutation(result);
    } catch {
      setForgetTarget(null);
      setStale(true);
      setError("暂时无法确认遗忘操作是否完成。请重新读取当前记忆后再继续。");
    } finally {
      forgetLock.current = false;
      setBusy(false);
    }
  }

  function renderForgetConfirmation(target: MemoryForgetTarget) {
    return <div className={styles.shareConfirmation} role="group" aria-label="确认忘记这条跨对话记忆">
      <p>确认后，这条内容将停止用于跨对话记忆；原聊天会保留。</p>
      <div className={styles.shareConfirmationActions}>
        <button type="button" onClick={() => setForgetTarget(null)} disabled={busy}>取消</button>
        <button type="button" className={styles.primaryButton} onClick={() => void confirmForget(target)} disabled={busy || stale}>{busy ? "正在忘记…" : "确认忘记"}</button>
      </div>
    </div>;
  }

  async function forgetPendingCorrection(pending: PrivateMemoryPendingCorrection) {
    if (!view || busy) return;
    if (!window.confirm("忘记这条更正及相关旧记忆？这会一并移除关联内容。")) return;
    setBusy(true);
    setError("");
    const result = await forgetPrivateMemoryItem(pending.id, pending.version, view.revision);
    await acceptMutation(result);
    setBusy(false);
  }

  async function clearAll() {
    const pendingCount = view?.pendingCorrections?.length ?? 0;
    if (!view || busy || view.items.length + pendingCount === 0) return;
    const contents = pendingCount > 0 ? "全部记忆和待澄清内容" : "全部记忆";
    if (!window.confirm(`清空${contents}？这会移除列表中的所有内容。`)) return;
    setBusy(true);
    setError("");
    const result = await clearPrivateMemory(view.revision);
    await acceptMutation(result);
    setBusy(false);
  }

  const items = view?.items ?? [];
  const pendingCorrections = view?.pendingCorrections ?? [];

  return (
    <section className={styles.memoryPanel} aria-labelledby="private-memory-heading">
      <button
        className={styles.memorySummary}
        type="button"
        aria-expanded={open}
        aria-controls="private-memory-content"
        onClick={() => setOpenAndLoad(!open)}
      >
        <span>
          <strong id="private-memory-heading">跨对话记忆</strong>
          <small>由你查看和管理，只用于你的私密对话</small>
        </span>
        <span aria-hidden="true">{open ? "收起" : "查看"}</span>
      </button>

      {open && <div id="private-memory-content" className={styles.memoryContent}>
        {loading && <p className={styles.memoryStatus} role="status">正在读取…</p>}
        {!loading && !view && !error && <p className={styles.memoryStatus}>还没有读取到记忆。</p>}
        {view && <>
          <p className={styles.memoryIntro}>为你记住相关关系线索，只用于你的私密对话，可纠正或忘记。</p>
          <div className={styles.memorySettings}>
            <span>
              <strong>允许潜谈记住相关线索</strong>
              <small>{view.enabled ? "已开启。你可以随时停用。" : "关闭时不会新增记忆，也不会在对话中使用。"}</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={view.enabled}
              disabled={busy || loading}
              onClick={() => void saveSettings(!view.enabled)}
            >{busy ? "保存中…" : view.enabled ? "已开启" : "启用"}</button>
          </div>
          <p className={styles.memoryBoundary}>这里记录的是你在私密对话中的说法或暂时理解，不代表伴侣已确认。</p>

          {pendingCorrections.length > 0 && <section className={styles.memoryGroup} aria-labelledby="memory-pending-corrections">
            <h3 id="memory-pending-corrections">需要你澄清</h3>
            <ul>{pendingCorrections.map((pending) => <li key={pending.id} className={styles.memoryItem}>
              {pending.content && <p>{pending.content}</p>}
              <p>{pending.reason === "no_target"
                ? "这次暂不使用相关旧记忆，等你说明是哪件事。"
                : pending.reason === "ambiguous_target"
                  ? "暂时停用可能相关的旧记忆，等你说明是哪件事。"
                  : "这次先不使用已有记忆，等你补充变化后再更新。"}</p>
              <span className={styles.memoryCorrection}>需要澄清</span>
              <div className={styles.memoryMeta}>
                <span>{pending.reason === "no_target" ? "没有找到对应的记忆" : pending.reason === "ambiguous_change" ? "变化内容还不够明确" : "可能对应多条记忆"}</span>
                <SourceLinks source={pending} label="查看本次原话" />
              </div>
              <div className={styles.memoryActions}>
                <button type="button" disabled={busy} onClick={() => void forgetPendingCorrection(pending)}>忘记这条更正及相关旧记忆</button>
              </div>
            </li>)}</ul>
          </section>}

          {items.length === 0 && pendingCorrections.length === 0 ? (
            <p className={styles.memoryStatus}>{view.enabled ? "有新的相关线索时，会在这里供你查看。" : "这里还没有记忆。"}</p>
          ) : items.length > 0 && <div className={styles.memoryGroups}>
            {groups.map((group) => {
              const groupItems = items.filter((item) => item.kind === group.kind);
              if (groupItems.length === 0) return null;
              return <section key={group.kind} className={styles.memoryGroup} aria-labelledby={`memory-${group.kind}`}>
                <h3 id={`memory-${group.kind}`}>{group.title}</h3>
                <ul>
                  {groupItems.map((item) => <li key={item.id} className={styles.memoryItem}>
                    {editingId === item.id ? <div className={styles.memoryEditor}>
                      <label htmlFor={`memory-edit-${item.id}`}>修改这条记忆</label>
                      <textarea id={`memory-edit-${item.id}`} value={draft} maxLength={1600} rows={3} onChange={(event) => setDraft(event.target.value)} disabled={busy} />
                      <div className={styles.memoryActions}>
                        <button type="button" disabled={busy} onClick={() => { setEditingId(null); setDraft(""); }}>取消</button>
                        <button type="button" className={styles.memoryPrimary} disabled={busy || !draft.trim()} onClick={() => void saveItem(item)}>{busy ? "保存中…" : "保存纠正"}</button>
                      </div>
                    </div> : <>
                      <p>{item.content}</p>
                      {item.correction && <span className={styles.memoryCorrection}>本人纠正</span>}
                      {item.correctionStatus === "applied" && <span className={styles.memoryCorrection}>已按新原话更新</span>}
                      <div className={styles.memoryMeta}>
                        <span>更新于 {Number.isFinite(item.updatedAt) ? new Date(item.updatedAt).toLocaleDateString("zh-CN") : "最近"}</span>
                        {item.supersedes?.length ? <>
                          <span>本次纠正来源</span>
                          <SourceLinks source={item} label="查看原话" />
                          <span>先前来源</span>
                          {item.supersedes.map((source, index) => <SourceLinks key={`${source.memoryItemId}-${index}`} source={source} label={`查看原话${item.supersedes!.length > 1 ? `（${index + 1}）` : ""}`} />)}
                        </> : item.sourceConversationId && <SourceLinks source={item} label="查看原对话" />}
                      </div>
                      {forgetTarget?.id === item.id && forgetTarget.version === item.version && forgetTarget.revision === view.revision
                        ? renderForgetConfirmation(forgetTarget)
                        : <div className={styles.memoryActions}>
                          <button type="button" disabled={busy} onClick={() => { setForgetTarget(null); setEditingId(item.id); setDraft(item.content); setError(""); }}>纠正</button>
                          <button type="button" disabled={busy || stale} onClick={() => requestForget(item)}>忘记</button>
                        </div>}
                    </>}
                  </li>)}
                </ul>
              </section>;
            })}
            {items.some((item) => !groups.some((group) => group.kind === item.kind)) && <section className={styles.memoryGroup} aria-labelledby="memory-other">
              <h3 id="memory-other">其他线索</h3>
              <ul>{items.filter((item) => !groups.some((group) => group.kind === item.kind)).map((item) => <li key={item.id} className={styles.memoryItem}>
                <p>{item.content}</p>
                <div className={styles.memoryMeta}>{item.sourceConversationId && <Link href={`/app/conversations/${encodeURIComponent(item.sourceConversationId)}`}>查看原对话</Link>}</div>
                {forgetTarget?.id === item.id && forgetTarget.version === item.version && forgetTarget.revision === view.revision
                  ? renderForgetConfirmation(forgetTarget)
                  : <div className={styles.memoryActions}>
                    <button type="button" disabled={busy} onClick={() => { setForgetTarget(null); setEditingId(item.id); setDraft(item.content); setError(""); }}>纠正</button>
                    <button type="button" disabled={busy || stale} onClick={() => requestForget(item)}>忘记</button>
                  </div>}
              </li>)}</ul>
            </section>}
          </div>}

          {items.length + pendingCorrections.length > 0 && <button type="button" className={styles.memoryClear} disabled={busy} onClick={() => void clearAll()}>{pendingCorrections.length > 0 ? "清空全部记忆和待澄清内容" : "清空全部记忆"}</button>}
        </>}
        {stale && <button type="button" className={styles.memoryReload} disabled={loading || busy} onClick={() => void reload()}>重新读取</button>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>}
    </section>
  );
}
