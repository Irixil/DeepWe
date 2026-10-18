"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  createPrivateConversation,
  deletePrivateConversation,
  getCurrentAccount,
  getPrivateConversations,
  getRegistrationStatus,
  updateAnalyticsPreference,
  loginAccount,
  logoutAccount,
  registerAccount,
  resetPassword,
  sendPrivateMessage,
} from "@/lib/api";
import type { AccountUser, PrivateConversation } from "@/lib/types";
import { trackAnalyticsBestEffort } from "@/lib/analytics";
import styles from "./private.module.css";
import PrivateAccountBoundary from "./PrivateAccountBoundary";
import PrivateMemoryPanel from "./PrivateMemoryPanel";

type AuthMode = "login" | "register" | "reset";

export function AuthCard({ onAccount }: { onAccount: (user: AccountUser) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [inviteRequired, setInviteRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getRegistrationStatus().then((result) => {
      if (!result.error) setInviteRequired(result.inviteRequired);
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (mode !== "login" && password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    const result: { user?: AccountUser; error?: string } = mode === "login"
      ? await loginAccount(email, password)
      : mode === "register"
        ? await registerAccount(displayName, email, password, registrationCode)
        : await resetPassword(email, resetCode, password);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (mode === "reset") {
      setMode("login");
      setPassword("");
      setConfirmPassword("");
      setResetCode("");
      setError("密码已重置，请使用新密码登录。");
      return;
    }
    if (!result.user) {
      setError("暂时无法登录，请稍后再试。");
      return;
    }
    onAccount(result.user);
  }

  return (
    <main className={`${styles.shell} deepwe-app-shell`}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.wordmark}>DeepWe <span>深蓝</span></Link>
        <span className={styles.privacyChip}>私密空间</span>
      </header>
      <section className={styles.authCard}>
        <h1>潜谈</h1>
        <p className={styles.lede}>和 AI 聊聊此刻最在意的事。从你想说的地方开始。</p>
        <div className={styles.authTabs} role="tablist" aria-label="账号操作">
          {(["login", "register"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={mode === value}
              onClick={() => { setMode(value); setError(""); }}>
              {value === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className={styles.form}>
          {mode === "register" && <label>怎么称呼你？
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={32} required autoComplete="nickname" />
          </label>}
          <label>邮箱
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </label>
          {mode === "reset" && <label>重置码
            <input value={resetCode} onChange={(event) => setResetCode(event.target.value)} required autoComplete="one-time-code" />
          </label>}
          <label>{mode === "login" ? "密码" : "新密码"}
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={mode === "login" ? undefined : 8} required autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </label>
          {mode !== "login" && <label>再次输入密码
            <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required autoComplete="new-password" />
          </label>}
          {mode === "register" && inviteRequired && <label>注册邀请码
            <input value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value)} required autoComplete="off" />
          </label>}
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "进入潜谈" : mode === "register" ? "创建账号" : "重置密码"}
          </button>
        </form>
        {mode === "login" && <button className={styles.textButton} type="button" onClick={() => { setMode("reset"); setError(""); }}>我有重置码</button>}
        {mode === "reset" && <button className={styles.textButton} type="button" onClick={() => { setMode("login"); setError(""); }}>返回登录</button>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <p className={styles.finePrint}>你的私密消息只在你的账号中显示。分享内容需要你另行整理并确认。</p>
      </section>
    </main>
  );
}

export default function PrivateConversationHome() {
  return <PrivateAccountBoundary><PrivateConversationHomeScreen /></PrivateAccountBoundary>;
}

function PrivateConversationHomeScreen() {
  const router = useRouter();
  const [account, setAccount] = useState<AccountUser | null | undefined>(undefined);
  const [conversations, setConversations] = useState<PrivateConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openingMessage, setOpeningMessage] = useState("");
  const [error, setError] = useState("");
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const firstMessageIdsRef = useRef(new Map<string, string>());
  const createRequestRef = useRef<{ ownerId: string; id: string } | null>(null);
  const creationEpochRef = useRef(0);
  const creationOwnerIdRef = useRef<string | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [privacyError, setPrivacyError] = useState("");

  useEffect(() => {
    return () => { creationEpochRef.current += 1; };
  }, []);

  useEffect(() => {
    const ownerId = account?.id ?? null;
    if (creationOwnerIdRef.current !== ownerId) {
      creationOwnerIdRef.current = ownerId;
      creationEpochRef.current += 1;
      createRequestRef.current = null;
      firstMessageIdsRef.current.clear();
      setCreatedConversationId(null);
      setOpeningMessage("");
      setError("");
    }
  }, [account?.id]);

  useEffect(() => {
    const syncHash = () => {
      if (window.location.hash === "#account-privacy") setPrivacyOpen(true);
    };
    const frame = window.requestAnimationFrame(syncHash);
    window.addEventListener("hashchange", syncHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncHash);
    };
  }, []);

  useEffect(() => {
    if (privacyOpen && window.location.hash === "#account-privacy") document.getElementById("account-privacy")?.scrollIntoView({ block: "start" });
  }, [privacyOpen]);

  useEffect(() => {
    let active = true;
    getCurrentAccount().then((result) => {
      if (!active) return;
      setAccount(result.error ? null : result.user);
      if (!result.error && result.user?.analyticsNoticeSeen && result.user.analyticsEnabled) trackAnalyticsBestEffort({ name: "app_opened", screen: "home", step: "home" });
      if (!result.error && result.user) {
        getPrivateConversations().then((list) => {
          if (!active) return;
          setConversations(list.conversations ?? []);
          if (list.error) setError(list.error);
          setLoading(false);
        });
      } else setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function createConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const firstMessage = openingMessage.trim();
    if (!firstMessage || creatingRef.current) return;
    const ownerId = account?.id;
    if (!ownerId) return;
    const operationEpoch = creationEpochRef.current;
    creatingRef.current = true;
    setCreating(true);
    setError("");
    try {
      let conversationId = createdConversationId;
      if (!conversationId) {
        let creation = createRequestRef.current;
        if (!creation || creation.ownerId !== ownerId) {
          creation = { ownerId, id: crypto.randomUUID() };
          createRequestRef.current = creation;
        }
        const created = await createPrivateConversation(undefined, creation.id);
        if (operationEpoch !== creationEpochRef.current) return;
        if (created.error || !created.conversation) {
          if (created.status === 409) createRequestRef.current = null;
          setError(created.status === 409
            ? "这次创建请求对应的对话已删除。再次提交会开始一段新的私密对话。"
            : created.error ?? "暂时无法开始对话，请稍后再试。你的文字还在输入框里。 ");
          return;
        }
        conversationId = created.conversation.id;
        createRequestRef.current = null;
        setCreatedConversationId(conversationId);
        if (account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "conversation_created", eventId: conversationId, screen: "conversation", step: "conversation" });
      }
      const requestId = firstMessageIdsRef.current.get(firstMessage) ?? crypto.randomUUID();
      firstMessageIdsRef.current.set(firstMessage, requestId);
      const result = await sendPrivateMessage(conversationId, firstMessage, requestId);
      if (operationEpoch !== creationEpochRef.current) return;
      if (result.message && account?.analyticsNoticeSeen && account.analyticsEnabled) trackAnalyticsBestEffort({ name: "conversation_message_sent", eventId: conversationId, screen: "conversation", step: "conversation" });
      if (result.error && !result.message) {
        setError(`${result.error} 对话已建立；再次提交会沿用同一段文字的请求编号，避免重复保存。`);
        return;
      }
      if (!result.jobId && !result.message) {
        setError("发送结果不确定。对话已建立；保留原文字重试会沿用同一请求编号。");
        return;
      }
      if (result.message && !result.jobId) {
        setError("首条消息已保存，但回复没有排入。可以打开这段对话查看；不要再次提交相同内容。");
        return;
      }
      router.push(`/app/conversations/${encodeURIComponent(conversationId)}`);
    } finally {
      setCreating(false);
      creatingRef.current = false;
    }
  }

  async function removeConversation(conversation: PrivateConversation) {
    if (!window.confirm("删除这段私密对话及其消息和未分享草稿？已进入双人空间的内容仍按双人规则管理。")) return;
    const result = await deletePrivateConversation(conversation.id);
    if (result.error) { setError(result.error); return; }
    setConversations((items) => items.filter((item) => item.id !== conversation.id));
  }

  async function saveAnalyticsPreference(enabled: boolean) {
    setPrivacyBusy(true);
    setPrivacyError("");
    const result = await updateAnalyticsPreference(enabled);
    setPrivacyBusy(false);
    if (result.error || result.analyticsEnabled === undefined) { setPrivacyError(result.error ?? "暂时无法保存设置，请稍后重试。"); return; }
    setAccount((current) => current ? { ...current, analyticsEnabled: result.analyticsEnabled, analyticsNoticeSeen: result.analyticsNoticeSeen ?? true } : current);
  }

  async function logout() {
    const result = await logoutAccount();
    if (result.error || result.ok !== true) {
      setError(result.error ?? "暂时无法退出，请稍后重试。你的账号仍保持登录。");
      return;
    }
    creationEpochRef.current += 1;
    creationOwnerIdRef.current = null;
    createRequestRef.current = null;
    firstMessageIdsRef.current.clear();
    setCreatedConversationId(null);
    setOpeningMessage("");
    setAccount(null);
    setConversations([]);
  }

  if (account === undefined && loading) {
    return <main className={`${styles.shell} deepwe-app-shell`}><div className={styles.loadingCard}>正在确认你的私密空间…</div></main>;
  }
  if (!account) return <AuthCard onAccount={(user) => {
    if (creationOwnerIdRef.current !== user.id) {
      creationEpochRef.current += 1;
      creationOwnerIdRef.current = user.id;
      createRequestRef.current = null;
      firstMessageIdsRef.current.clear();
      setCreatedConversationId(null);
      setOpeningMessage("");
    }
    setAccount(user);
    getPrivateConversations().then((result) => {
      setConversations(result.conversations ?? []);
      if (result.error) setError(result.error);
    });
  }} />;

  return (
    <main className={`${styles.shell} deepwe-app-shell`}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.wordmark}>DeepWe <span>深蓝</span></Link>
        <nav className={styles.topActions} aria-label="账号与空间">
          {account.isOwner && <Link href="/app/admin" className={styles.quietLink}>管理面板</Link>}
          <Link href="/app/couple" className={styles.quietLink}>双人空间</Link>
          <button type="button" className={styles.quietLink} aria-expanded={privacyOpen} onClick={() => setPrivacyOpen((open) => !open)}>账号与隐私</button>
          <button type="button" className={styles.quietLink} onClick={logout}>退出</button>
        </nav>
      </header>

      {privacyOpen && <section id="account-privacy" className={styles.accountPanel} aria-label="账号与隐私设置"><div><h2>{account.displayName} · 账号与隐私</h2><p>这里是 AI 情绪支持，不提供诊断或治疗。生成回复、对话要点和你主动整理的分享草稿时，相关必要内容会发送到配置的 AI 模型服务处理。伴侣只会收到你确认分享的文字；体验统计不包含对话正文。</p></div><div className={styles.privacyToggle}><span><strong>允许记录非内容体验数据</strong><small>关闭后会停止新增并删除此前的原始体验事件。</small></span><button type="button" role="switch" aria-checked={account.analyticsEnabled === true} disabled={privacyBusy} onClick={() => void saveAnalyticsPreference(account.analyticsEnabled !== true)}>{privacyBusy ? "保存中…" : account.analyticsEnabled ? "已开启" : "已关闭"}</button></div>{privacyError && <p className={styles.error} role="alert">{privacyError}</p>}<Link href="/app/couple" className={styles.accountLink}>伴侣绑定与双人复盘设置 →</Link></section>}

      <div className={styles.content}>
        <section className={`${styles.welcome} ${styles.paper}`}>
          <h1>潜谈</h1>
          <p>和 AI 聊聊今天最占着你心的事。从你现在最想说的地方开始。</p>
          <div className={styles.privacyNote}><span aria-hidden="true">●</span> 这里只属于你，你的聊天原文不会分享给伴侣。</div>
          {!account.analyticsNoticeSeen && <section className={styles.analyticsNotice} aria-label="体验数据说明"><h2>关于可选的体验数据</h2><p>为改进页面和服务，我们可记录页面步骤、请求成败及模型用量。不会记录聊天内容、AI 回复、摘要、标题、姓名、键盘输入或录屏。你可拒绝，之后也能在“账号与隐私”关闭；关闭会删除此前的原始体验事件。</p><div><button type="button" onClick={() => void saveAnalyticsPreference(false)} disabled={privacyBusy}>不允许，继续使用</button><button type="button" className={styles.primaryButton} onClick={() => void saveAnalyticsPreference(true)} disabled={privacyBusy}>允许记录非内容数据</button></div>{privacyError && <p className={styles.error} role="alert">{privacyError}</p>}</section>}
          <form className={styles.createForm} onSubmit={createConversation}>
            <label htmlFor="opening-message">你想从哪里说起？</label>
            <div className={styles.composerRow}>
              <textarea id="opening-message" value={openingMessage} onChange={(event) => setOpeningMessage(event.target.value)} maxLength={6000} rows={5} placeholder="比如：这两天有件事一直卡在心里……" disabled={creating} />
              <div className={styles.composerFooter}><span>可以只说一点，也可以慢慢写。</span>
                <button className={styles.primaryButton} type="submit" disabled={creating || !openingMessage.trim()}>{creating ? "正在开始潜谈…" : "开始潜谈"}</button>
              </div>
            </div>
          </form>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          {createdConversationId && error && <Link className={styles.recoveryLink} href={`/app/conversations/${encodeURIComponent(createdConversationId)}`}>打开已建立的对话</Link>}
        </section>

        <PrivateMemoryPanel />

        <section className={styles.history} aria-labelledby="history-heading">
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>只对你可见</p><h2 id="history-heading">继续之前的对话</h2></div>
            <span>{conversations.length} 段</span>
          </div>
          {loading ? <div className={styles.emptyCard}>正在读取…</div> : conversations.length === 0 ? (
            <div className={styles.emptyCard}><span className={styles.emptyMark} aria-hidden="true">○</span><p>这里还没有对话记录。</p><small>开始后，你可以随时离开，再回来继续。</small></div>
          ) : (
            <ul className={styles.conversationList}>
              {conversations.filter((item) => item.status === "active").map((conversation) => (
                <li key={conversation.id}>
                  <div className={styles.conversationRow}>
                  <Link href={`/app/conversations/${encodeURIComponent(conversation.id)}`} className={styles.conversationLink}>
                    <span className={styles.conversationIcon} aria-hidden="true">↗</span>
                    <span className={styles.conversationText}><strong>{conversation.title || "继续这段对话"}</strong><small>{conversation.pendingJobCount ? "有一条回复正在准备" : `上次继续于 ${new Date(conversation.lastMessageAt ?? conversation.updatedAt).toLocaleDateString("zh-CN")}`}</small></span>
                    <span className={styles.arrow} aria-hidden="true">→</span>
                  </Link>
                  <button type="button" className={styles.deleteConversation} aria-label={`删除${conversation.title || "这段对话"}`} onClick={() => void removeConversation(conversation)}>删除</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

      <footer className={styles.footer}>只有你主动整理、修改并确认的分享内容，才会进入双人复盘。</footer>
      </div>
    </main>
  );
}
