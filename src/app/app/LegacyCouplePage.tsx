"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createPartnerInvite,
  createRegistrationInvite,
  declineEvent,
  createPasswordResetCode,
  changePassword,
  deleteAccount,
  deleteEvent,
  snoozePartnerEventInvite,
  endPartnerConnection,
  pausePartnerConnection,
  resumePartnerConnection,
  cancelPartnerDisconnect,
  approvePartnerBinding,
  cancelPartnerBinding,
  requestPartnerRecovery,
  approvePartnerRecovery,
  exportAccountData,
  getAdminUsers,
  markAnalyticsNoticeSeen,
  getCurrentAccount,
  getMyEvents,
  getPartnerOverview,
  getRegistrationInvites,
  getRegistrationStatus,
  loginAccount,
  logoutAccount,
  logoutAllDevices,
  renameEvent,
  requestEventDeletion,
  resetPassword,
  registerAccount,
  acceptPartnerEventInvite,
  acceptPartnerInvite,
  confirmSharedSpaceProposal,
  createSharedSpaceProposal,
  getSharedSpace,
  rejectSharedSpaceProposal,
  reviseSharedSpaceProposal,
  revokePartnerInvite,
  revokeRegistrationInvite,
  updateAnalyticsPreference,
} from "@/lib/api";
import { trackAnalyticsBestEffort } from "@/lib/analytics";
import type {
  AccountEventSummary,
  AccountUser,
  AdminRegistrationInvite,
  PartnerOverview,
  SharedMemoryCategory,
  SharedSpaceOverview,
  SharedSpaceProposal,
} from "@/lib/types";
import styles from "../home.module.css";
import AdminAnalyticsPanel from "./AdminAnalyticsPanel";

const EVENT_STATE_LABEL: Record<string, string> = {
  a_guiding: "潜谈中",
  a_summary: "待确认表达",
  waiting_b: "等待对方加入",
  b_guiding: "对方潜谈中",
  b_summary: "等待共同整理",
  merged: "共同理解中",
  agreement_proposed: "确认下一步",
  done: "等待回望",
  completed: "已完成",
  declined: "对方未加入",
  cancelled: "已撤回",
  closed: "已结束",
  safety_exit: "已停止普通流程",
};

const SHARED_MEMORY_LABEL: Record<SharedMemoryCategory, string> = {
  communication_method: "我们适合怎样沟通",
  support_method: "难受时怎样陪伴",
  repair_method: "冲突后怎样修复",
  relationship_priority: "我们共同在意什么",
};

type AppTab = "couple" | "records" | "me";

const APP_TABS: Record<AppTab, { label: string; path: string }> = {
  couple: { label: "双人", path: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" },
  records: { label: "复盘", path: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4" },
  me: { label: "我的", path: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" },
};

function scrollToSection(target: string) {
  document.getElementById(target)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
}

function ScrollCue({
  target,
  label,
  children,
}: {
  target: string;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => scrollToSection(target)}
      className={styles.scrollCue}
      aria-label={label}
    >
      <span>{children ?? label}</span>
      <span className={styles.cueLine} aria-hidden="true" />
    </button>
  );
}

function BrandLockup({ className }: { className: string }) {
  return (
    <div className={className} aria-label="DeepWe深蓝">
      <span className={styles.brandEnglish}>DeepWe深蓝</span>
    </div>
  );
}

function ResponsiveScene({
  mobileSrc,
  desktopSrc,
  label,
  className,
  priority = false,
}: {
  mobileSrc: string;
  desktopSrc: string;
  label?: string;
  className: string;
  priority?: boolean;
}) {
  return (
    <div
      className={styles.sceneArt}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Image
        src={mobileSrc}
        alt=""
        fill
        priority={priority}
        sizes="(max-width: 719px) 100vw, 1px"
        className={`${styles.sceneImage} ${styles.sceneImageMobile} ${className}`}
        aria-hidden="true"
      />
      <Image
        src={desktopSrc}
        alt=""
        fill
        priority={priority}
        sizes="(max-width: 719px) 1px, 100vw"
        className={`${styles.sceneImage} ${styles.sceneImageDesktop} ${className}`}
        aria-hidden="true"
      />
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [account, setAccount] = useState<AccountUser | null | undefined>(undefined);
  const [myEvents, setMyEvents] = useState<AccountEventSummary[]>([]);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AccountEventSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "reset">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [partnerInviteFromLink, setPartnerInviteFromLink] = useState(false);
  const [passwordResetCode, setPasswordResetCode] = useState("");
  const [inviteRequired, setInviteRequired] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [adminInvites, setAdminInvites] = useState<AdminRegistrationInvite[]>([]);
  const [inviteNote, setInviteNote] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminRefreshing, setAdminRefreshing] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const [adminUsers, setAdminUsers] = useState<AccountUser[]>([]);
  const [generatedReset, setGeneratedReset] = useState<{ name: string; code: string; expiresAt: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
  const [pendingRename, setPendingRename] = useState<AccountEventSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [homeNotice, setHomeNotice] = useState("");
  const [partnerOverview, setPartnerOverview] = useState<PartnerOverview | null>(null);
  const [partnerCode, setPartnerCode] = useState("");
  const [partnerBusy, setPartnerBusy] = useState(false);
  const [partnerError, setPartnerError] = useState("");
  const [partnerJoinOpen, setPartnerJoinOpen] = useState(false);
  const [partnerSettingsOpen, setPartnerSettingsOpen] = useState(false);
  const [partnerDisconnectOpen, setPartnerDisconnectOpen] = useState(false);
  const [copiedPartnerInvite, setCopiedPartnerInvite] = useState(false);
  const [sharedSpace, setSharedSpace] = useState<SharedSpaceOverview | null>(null);
  const [sharedSpaceOpen, setSharedSpaceOpen] = useState(false);
  const [sharedSpaceBusy, setSharedSpaceBusy] = useState(false);
  const [sharedSpaceError, setSharedSpaceError] = useState("");
  const [sharedProposalOpen, setSharedProposalOpen] = useState(false);
  const [sharedProposalCategory, setSharedProposalCategory] =
    useState<SharedMemoryCategory>("communication_method");
  const [sharedProposalContent, setSharedProposalContent] = useState("");
  const [editingSharedProposalId, setEditingSharedProposalId] = useState<string | null>(null);
  const [activeAppTab, setActiveAppTab] = useState<AppTab>("couple");
  const [appSectionVisible, setAppSectionVisible] = useState(false);
  const [pageOpenedAt] = useState(() => Date.now());
  const accountId = account?.id;

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("tab");
    if (value === "home") {
      router.replace("/app");
      return;
    }
    if (value !== "couple" && value !== "records" && value !== "me") return;
    const timer = window.setTimeout(() => setActiveAppTab(value), 0);
    return () => window.clearTimeout(timer);
  }, [router]);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("partner");
    if (!value) return;
    const normalized = value.toUpperCase();
    const timer = window.setTimeout(() => {
      setRegistrationCode(normalized);
      setPartnerCode(normalized);
      setPartnerInviteFromLink(true);
      setAuthMode("register");
      setActiveAppTab("couple");
      scrollToSection("deepwe-start");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([getCurrentAccount(), getRegistrationStatus()]).then(
      ([accountResult, registrationResult]) => {
        if (!active) return;
        setAccount(accountResult.error ? null : accountResult.user);
        if (!registrationResult.error) setInviteRequired(registrationResult.inviteRequired);
      }
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const section = document.getElementById("deepwe-start");
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => setAppSectionVisible(entry.isIntersecting),
      { threshold: 0.02 }
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!account) return;
    let active = true;
    getMyEvents().then((result) => {
      if (active && result.events) setMyEvents(result.events);
    });
    return () => {
      active = false;
    };
  }, [account]);

  useEffect(() => {
    if (!accountId) return;
    trackAnalyticsBestEffort({ name: "app_opened", screen: "home", step: "home" });
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    const enteredAt = Date.now();
    trackAnalyticsBestEffort({
      name: "screen_viewed",
      screen: activeAppTab,
      step: activeAppTab,
    });
    return () => {
      trackAnalyticsBestEffort({
        name: "screen_left",
        screen: activeAppTab,
        step: activeAppTab,
        durationMs: Date.now() - enteredAt,
      });
    };
  }, [accountId, activeAppTab]);

  useEffect(() => {
    if (!account || !sharedSpaceOpen || !partnerOverview?.connection) return;
    let active = true;
    const timer = window.setInterval(() => {
      getSharedSpace().then((result) => {
        if (active && result.space) setSharedSpace(result.space);
      });
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [account, partnerOverview?.connection, sharedSpaceOpen]);

  useEffect(() => {
    if (!account) return;
    let active = true;
    const refresh = () => {
      getPartnerOverview().then((result) => {
        if (active && !result.error) {
          setPartnerOverview(result);
          if (!result.connection) {
            setSharedSpace(null);
            setSharedSpaceOpen(false);
          }
        }
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [account]);

  useEffect(() => {
    if (!account?.isOwner) return;
    let active = true;
    const refresh = () => {
      getRegistrationInvites().then((result) => {
        if (active && result.invites) setAdminInvites(result.invites);
      });
    };
    getAdminUsers().then((result) => {
      if (active && result.users) setAdminUsers(result.users);
    });
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [account]);

  async function onRefreshRegistrationInvites() {
    setAdminRefreshing(true);
    setAdminError("");
    const result = await getRegistrationInvites();
    setAdminRefreshing(false);
    if (result.error || !result.invites) {
      setAdminError(result.error ?? "暂时无法刷新邀请码状态");
      return;
    }
    setAdminInvites(result.invites);
  }

  async function onAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    if ((authMode === "register" || authMode === "reset") && password !== confirmPassword) {
      setAuthError("两次输入的密码不一致");
      return;
    }
    setAuthBusy(true);
    const result = authMode === "register"
      ? await registerAccount(displayName, email, password, registrationCode)
      : authMode === "reset"
        ? await resetPassword(email, passwordResetCode, password)
        : await loginAccount(email, password);
    setAuthBusy(false);
    if (authMode === "reset") {
      if (result.error) {
        setAuthError(result.error);
        return;
      }
      setPassword("");
      setConfirmPassword("");
      setPasswordResetCode("");
      setAuthMode("login");
      setAuthError("密码已经重置，请使用新密码登录");
      return;
    }
    if (result.error || !("user" in result) || !result.user) {
      setAuthError(result.error ?? "暂时无法登录，请稍后重试");
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setRegistrationCode("");
    setAccount(result.user);
  }

  async function onLogout() {
    setAuthBusy(true);
    await logoutAccount();
    setAuthBusy(false);
    setAccount(null);
    setMyEvents([]);
    setAdminInvites([]);
    setPartnerOverview(null);
    setSharedSpace(null);
    setSharedSpaceOpen(false);
  }

  async function refreshPartnerOverview() {
    const result = await getPartnerOverview();
    if (result.error) {
      setPartnerError(result.error);
      return null;
    }
    setPartnerOverview(result);
    if (!result.connection) {
      setSharedSpace(null);
      setSharedSpaceOpen(false);
    }
    return result;
  }

  async function onCreatePartnerInvite() {
    if (!window.confirm("邀请前请确认：每个账号同时只能绑定一位伴侣。绑定不会共享任何一方的私密聊天或个人偏好；共同内容只有双方确认后才会保存。继续生成邀请吗？")) return;
    setPartnerBusy(true);
    setPartnerError("");
    const result = await createPartnerInvite();
    setPartnerBusy(false);
    if (result.error || !result.invite) {
      setPartnerError(result.error ?? "暂时无法生成伴侣邀请");
      return;
    }
    setPartnerOverview((current) => ({
      connection: null,
      outgoingInvite: result.invite!,
      bindingRequest: null,
      archivedConnection: current?.archivedConnection ?? null,
      eventInvites: current?.eventInvites ?? [],
    }));
  }

  async function onCopyPartnerInvite() {
    const invite = partnerOverview?.outgoingInvite;
    if (!invite) return;
    const link = `${window.location.origin}/app/couple?partner=${encodeURIComponent(invite.code)}#deepwe-start`;
    const content = `我想邀请你和我一起使用 DeepWe深蓝。你可以用这个链接注册并连接我们的双人空间：${link}`;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedPartnerInvite(true);
      window.setTimeout(() => setCopiedPartnerInvite(false), 1800);
    } catch {
      setPartnerError("复制失败，请手动复制连接码");
    }
  }

  async function onRevokePartnerInvite() {
    const invite = partnerOverview?.outgoingInvite;
    if (!invite) return;
    setPartnerBusy(true);
    setPartnerError("");
    const result = await revokePartnerInvite(invite.id);
    setPartnerBusy(false);
    if (result.error) {
      setPartnerError(result.error);
      return;
    }
    await refreshPartnerOverview();
  }

  async function onAcceptPartnerInvite(e: React.FormEvent) {
    e.preventDefault();
    setPartnerBusy(true);
    setPartnerError("");
    const result = await acceptPartnerInvite(partnerCode);
    setPartnerBusy(false);
    if (result.error) {
      setPartnerError(result.error);
      return;
    }
    setPartnerCode("");
    setPartnerJoinOpen(false);
    setPartnerInviteFromLink(false);
    window.history.replaceState({}, "", `${window.location.pathname}#deepwe-start`);
    await refreshPartnerOverview();
    setHomeNotice("申请已经发出，等待对方确认后才会绑定");
    window.setTimeout(() => setHomeNotice(""), 2200);
  }

  async function onEndPartnerConnection() {
    setPartnerBusy(true);
    setPartnerError("");
    const result = await endPartnerConnection();
    setPartnerBusy(false);
    if (result.error) {
      setPartnerError(result.error);
      return;
    }
    setPartnerDisconnectOpen(false);
    await refreshPartnerOverview();
    setHomeNotice("已停止共同互动；24 小时内可以撤销解绑");
    window.setTimeout(() => setHomeNotice(""), 2200);
  }

  function resetSharedProposalForm() {
    setSharedProposalOpen(false);
    setEditingSharedProposalId(null);
    setSharedProposalCategory("communication_method");
    setSharedProposalContent("");
  }

  async function onToggleSharedSpace() {
    if (sharedSpaceOpen) {
      setSharedSpaceOpen(false);
      resetSharedProposalForm();
      return;
    }
    setSharedSpaceOpen(true);
    setSharedSpaceBusy(true);
    setSharedSpaceError("");
    const result = await getSharedSpace();
    setSharedSpaceBusy(false);
    if (result.error || !result.space) {
      setSharedSpaceError(result.error ?? "暂时无法进入共同空间");
      return;
    }
    setSharedSpace(result.space);
  }

  function onEditSharedProposal(proposal: SharedSpaceProposal) {
    setEditingSharedProposalId(proposal.id);
    setSharedProposalCategory(proposal.category);
    setSharedProposalContent(proposal.content);
    setSharedProposalOpen(true);
    setSharedSpaceError("");
  }

  async function onSubmitSharedProposal(event: React.FormEvent) {
    event.preventDefault();
    const content = sharedProposalContent.trim();
    if (!content) return;
    if (!window.confirm("这条内容会提交到共同空间，只有双方确认后才会生效；你的其他私密聊天不会被带入。继续吗？")) return;
    setSharedSpaceBusy(true);
    setSharedSpaceError("");
    const result = editingSharedProposalId
      ? await reviseSharedSpaceProposal(editingSharedProposalId, content)
      : await createSharedSpaceProposal(sharedProposalCategory, content);
    setSharedSpaceBusy(false);
    if (result.error || !result.space) {
      setSharedSpaceError(result.error ?? "暂时无法提交这条共同内容");
      return;
    }
    setSharedSpace(result.space);
    resetSharedProposalForm();
    setHomeNotice("已提交，等待双方确认");
    window.setTimeout(() => setHomeNotice(""), 2200);
  }

  async function onConfirmSharedProposal(id: string, expectedVersion: number) {
    if (!window.confirm("确认后，这条内容将在双方都同意时成为共同内容。已生效的旧版本会保留记录。继续吗？")) return;
    setSharedSpaceBusy(true);
    setSharedSpaceError("");
    const result = await confirmSharedSpaceProposal(id, expectedVersion);
    if (result.error || !result.space) {
      const refreshed = await getSharedSpace();
      setSharedSpace(refreshed.space ?? null);
      setSharedSpaceBusy(false);
      setSharedSpaceError(`${result.error ?? "这条内容暂时无法确认"}。${refreshed.space
        ? "共同空间已刷新，请重新阅读当前内容后再确认。"
        : "共同空间暂时无法刷新，请收起后重新打开并阅读内容后再确认。"}`);
      return;
    }
    setSharedSpaceBusy(false);
    setSharedSpace(result.space);
    setHomeNotice("你已确认这条共同内容");
    window.setTimeout(() => setHomeNotice(""), 2200);
  }

  async function onRejectSharedProposal(id: string) {
    setSharedSpaceBusy(true);
    setSharedSpaceError("");
    const result = await rejectSharedSpaceProposal(id);
    setSharedSpaceBusy(false);
    if (result.error || !result.space) {
      setSharedSpaceError(result.error ?? "这条内容暂时无法处理");
      return;
    }
    setSharedSpace(result.space);
  }

  async function onAcceptPartnerEvent(id: string) {
    setPartnerBusy(true);
    setPartnerError("");
    const result = await acceptPartnerEventInvite(id);
    setPartnerBusy(false);
    if (result.error || !(result.conversationId || result.id || result.eventId)) {
      setPartnerError(result.error ?? "这次邀请暂时无法接受");
      await refreshPartnerOverview();
      return;
    }
    if (result.conversationId) {
      router.push(`/app/conversations/${encodeURIComponent(result.conversationId)}`);
    } else {
      router.push(`/e/${result.eventId ?? result.id}`);
    }
  }

  async function onSnoozePartnerEvent(id: string) {
    setPartnerBusy(true);
    setPartnerError("");
    const result = await snoozePartnerEventInvite(id);
    setPartnerBusy(false);
    if (result.error) {
      setPartnerError(result.error);
      return;
    }
    await refreshPartnerOverview();
  }

  async function runPartnerAction(action: () => Promise<{ error?: string }>, notice: string) {
    setPartnerBusy(true);
    setPartnerError("");
    const result = await action();
    setPartnerBusy(false);
    if (result.error) { setPartnerError(result.error); return; }
    await refreshPartnerOverview();
    setHomeNotice(notice);
    window.setTimeout(() => setHomeNotice(""), 2200);
  }

  async function onCreateRegistrationInvite(e: React.FormEvent) {
    e.preventDefault();
    setAdminBusy(true);
    setAdminError("");
    const result = await createRegistrationInvite(inviteNote);
    setAdminBusy(false);
    if (result.error || !result.invite) {
      setAdminError(result.error ?? "暂时无法生成邀请码");
      return;
    }
    setInviteNote("");
    setAdminInvites((current) => [result.invite!, ...current]);
  }

  async function onRevokeRegistrationInvite(id: string) {
    setAdminBusy(true);
    setAdminError("");
    const result = await revokeRegistrationInvite(id);
    setAdminBusy(false);
    if (result.error) {
      setAdminError(result.error);
      return;
    }
    setAdminInvites((current) => current.filter((invite) => invite.id !== id));
  }

  async function copyRegistrationInvite(invite: AdminRegistrationInvite) {
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopiedInviteId(invite.id);
      setTimeout(() => setCopiedInviteId(null), 1500);
    } catch {
      setAdminError("复制失败，请手动复制邀请码");
    }
  }

  async function onGeneratePasswordReset(user: AccountUser) {
    setAdminBusy(true);
    setAdminError("");
    const result = await createPasswordResetCode(user.id);
    setAdminBusy(false);
    if (result.error || !result.reset) {
      setAdminError(result.error ?? "暂时无法生成重置码");
      return;
    }
    setGeneratedReset({ name: user.displayName, ...result.reset });
  }

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setSettingsBusy(true);
    setSettingsMessage("");
    const result = await changePassword(currentPassword, newPassword);
    setSettingsBusy(false);
    if (result.error) {
      setSettingsMessage(result.error);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setSettingsMessage("密码已更新，其他登录会话已失效");
  }

  async function onDismissAnalyticsNotice(openSettings = false) {
    setAnalyticsBusy(true);
    const result = await markAnalyticsNoticeSeen();
    setAnalyticsBusy(false);
    if (result.analyticsNoticeSeen) setAccount((current) => current ? { ...current, analyticsNoticeSeen: true } : current);
    if (openSettings) {
      setActiveAppTab("me");
      setSettingsOpen(true);
    }
  }

  async function onToggleAnalytics(enabled: boolean) {
    setAnalyticsBusy(true);
    setSettingsMessage("");
    const result = await updateAnalyticsPreference(enabled);
    setAnalyticsBusy(false);
    if (result.error || result.analyticsEnabled === undefined) {
      setSettingsMessage(result.error ?? "暂时无法更新体验数据设置");
      return;
    }
    setAccount((current) => current ? { ...current, analyticsEnabled: result.analyticsEnabled, analyticsNoticeSeen: result.analyticsNoticeSeen ?? true } : current);
    setSettingsMessage(
      enabled
        ? "体验数据已开启，只会记录之后的非内容数据"
        : "体验数据已关闭，你之前的原始体验记录也已删除"
    );
    window.setTimeout(() => setSettingsMessage(""), 3000);
  }

  async function onLogoutAll() {
    setSettingsBusy(true);
    await logoutAllDevices();
    setSettingsBusy(false);
    setAccount(null);
    setMyEvents([]);
  }

  async function onExportData() {
    setSettingsBusy(true);
    setSettingsMessage("");
    const result = await exportAccountData();
    setSettingsBusy(false);
    if (result.error || !result.data) {
      setSettingsMessage(result.error ?? "暂时无法导出数据");
      return;
    }
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `DeepWe深蓝-我的数据-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setSettingsMessage("数据已导出；文件不包含对方的私密潜谈");
    window.setTimeout(() => setSettingsMessage(""), 2500);
  }

  async function onDeleteAccount() {
    setSettingsBusy(true);
    setSettingsMessage("");
    const result = await deleteAccount(deleteAccountPassword);
    setSettingsBusy(false);
    if (result.error) {
      setSettingsMessage(result.error);
      return;
    }
    setDeleteAccountPassword("");
    setDeleteAccountOpen(false);
    setSettingsOpen(false);
    setAccount(null);
    setMyEvents([]);
  }

  async function onConfirmRename() {
    if (!pendingRename || !renameTitle.trim()) return;
    setRenameBusy(true);
    setRenameError("");
    const result = await renameEvent(pendingRename.id, renameTitle.trim());
    setRenameBusy(false);
    if (result.error) {
      setRenameError(result.error);
      return;
    }
    setMyEvents((current) =>
      current.map((item) => item.id === pendingRename.id ? { ...item, title: renameTitle.trim() } : item)
    );
    setPendingRename(null);
    setHomeNotice("对话名称已修改");
    window.setTimeout(() => setHomeNotice(""), 2200);
  }

  async function onConfirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError("");
    const result = await deleteEvent(pendingDelete.id);
    setDeleteBusy(false);
    if (result.error) {
      setDeleteError(result.error);
      return;
    }
    setMyEvents((current) => current.filter((item) => item.id !== pendingDelete.id));
    setPendingDelete(null);
  }

  async function onRequestPermanentDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setDeleteError("");
    const result = await requestEventDeletion(pendingDelete.id);
    setDeleteBusy(false);
    if (result.error) { setDeleteError(result.error); return; }
    if (result.status === "deleted") {
      setMyEvents((current) => current.filter((item) => item.id !== pendingDelete.id));
      setHomeNotice("双方已确认，这次共同复盘已永久删除");
    } else {
      setMyEvents((current) => current.map((item) => item.id === pendingDelete.id ? { ...item, deletionRequestedByMe: true } : item));
      setHomeNotice("已提出永久删除，等待对方确认");
    }
    setPendingDelete(null);
    window.setTimeout(() => setHomeNotice(""), 2500);
  }

  const showBrandIntro = false;

  return (
    <main className={`deepwe-app-shell ${styles.experience} ${styles.applicationExperience}`}>
      {homeNotice && (
        <div className="pointer-events-none fixed left-1/2 top-5 z-[60] -translate-x-1/2 rounded-full bg-slate-800/90 px-4 py-2 text-xs text-white shadow-lg">
          {homeNotice}
        </div>
      )}
      {showBrandIntro && <>
      <section id="shore" className={styles.storyScreen}>
        <div className={styles.portraitFrame}>
          <ResponsiveScene
            mobileSrc="/brand/shore-story-mobile-v3.png"
            desktopSrc="/brand/shore-story-wide-v3.png"
            label="一对年轻男女牵手沿着海岸线并肩行走"
            className={styles.shoreImage}
            priority
          />
          <div className={styles.shoreTint} aria-hidden="true" />
          <BrandLockup className={styles.wordmark + " " + styles.wordmarkDark} />
          <div className={styles.shoreCopy + " " + styles.shoreCopySand}>
            <p className={styles.shorePrelude}>
              让两人的关系<strong className={styles.emphasisInline}>不止</strong>停留在
            </p>
            <h1 className={styles.shoreTitle}>
              <strong className={styles.emphasisDisplay}>浅滩</strong>的浪漫。
            </h1>
          </div>
          <div className={styles.shoreCopy + " " + styles.shoreCopySea}>
            <p className={styles.shoreClosing}>
              而是陪伴<strong className={styles.emphasisInline}>彼此</strong>潜入
              <strong className={styles.emphasisInline}>深海</strong>
              <br />
              探索那个未曾被看见的<strong className={styles.emphasisInline}>自己</strong>
            </p>
          </div>
          <ScrollCue target="dive" label="上滑，潜入海面之下" />
        </div>
      </section>

      <section id="dive" className={styles.storyScreen}>
        <div className={styles.portraitFrame}>
          <ResponsiveScene
            mobileSrc="/brand/dive-story-mobile-v4.png"
            desktopSrc="/brand/dive-story-wide-v4.png"
            label="一对年轻男女牵手，自由潜入充满鱼群和珊瑚的深海"
            className={styles.diveImage}
            priority
          />
          <div className={styles.diveTint} aria-hidden="true" />
          <BrandLockup className={styles.wordmark + " " + styles.wordmarkLight} />
          <div className={styles.diveCopy}>
            <p className={styles.diveKicker}>GO DEEPER, TOGETHER.</p>
            <h2 className={styles.diveTitle}>
              牵住<strong className={styles.emphasisInline}>彼此</strong>
              <br />
              向未知的<strong className={styles.emphasisInline}>深处</strong>下潜
            </h2>
          </div>
          <p className={styles.diveCaption}>
            <strong className={styles.emphasisInline}>彼此</strong>陪伴，也各自看见
            <strong className={styles.emphasisInline}>自己</strong>
          </p>
          <ScrollCue target="promise" label="继续，看见深处的世界">
            继续，看见深处的<strong className={styles.cueEmphasis}>世界</strong>
          </ScrollCue>
        </div>
      </section>

      <section id="promise" className={styles.storyScreen + " " + styles.promiseScreen}>
        <div className={styles.portraitFrame}>
          <ResponsiveScene
            mobileSrc="/brand/promise-story-mobile-v2.png"
            desktopSrc="/brand/promise-story-wide-v2.png"
            className={styles.deepWorldImage}
          />
          <div className={styles.promiseTint} aria-hidden="true" />
          <BrandLockup className={styles.promiseWordmark} />
          <div className={styles.promiseContent}>
            <p className={styles.promiseKicker}>抵达深处之后</p>
            <h2 className={styles.promiseTitle}>
              先把故事说完整
              <br />
              再一起看清关系
            </h2>
            <p className={styles.promiseBody}>
              DeepWe深蓝会先完整听你说，确认理解无误后，再陪你梳理感受、需要和下一步。
            </p>
            <div className={styles.principles} aria-label="产品原则">
              <span>不急着评判</span>
              <i>·</i>
              <span>不替你站队</span>
              <i>·</i>
              <span>不替你决定</span>
            </div>
            <button
              type="button"
              onClick={() => scrollToSection("deepwe-start")}
              className={styles.enterButton}
            >
              进入 DeepWe深蓝 <span aria-hidden="true">↓</span>
            </button>
          </div>
        </div>
      </section>

      </>}

      <section
        id="deepwe-start"
        className={`${styles.productScreen} ${account ? styles.productScreenApp : ""}`}
      >
        <div className={`${styles.productInner} ${account ? styles.appProductInner : ""}`}>
          {!account && (
            <header className={styles.productHeader}>
              <BrandLockup className={styles.productWordmark} />
              <h2>从一件具体的事开始</h2>
              <p>一起走进关系深处</p>
            </header>
          )}

          {account === undefined && (
            <section className={styles.productCard + " p-6 text-center text-sm text-slate-500"}>
              正在确认登录状态…
            </section>
          )}

          {account === null && (
            <section className={styles.productCard + " p-6"}>
              <h3 className="text-base font-semibold text-slate-900">先进入你的私密空间</h3>
              <p className="mt-1 text-sm leading-6 text-muted">
                登录后，你的潜谈才能只归属于你，也可以在下次回来时继续。密码不会被明文保存。
              </p>
              <div className="mt-5 grid grid-cols-2 rounded-full bg-slate-100 p-1" role="tablist">
                {(["login", "register"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={authMode === mode}
                    onClick={() => {
                      setAuthMode(mode);
                      setAuthError("");
                    }}
                    className={`rounded-full py-2 text-sm font-medium transition ${
                      authMode === mode ? "bg-white text-primary shadow-sm" : "text-slate-500"
                    }`}
                  >
                    {mode === "login" ? "登录" : "注册"}
                  </button>
                ))}
              </div>
              {authMode === "login" && (
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode("reset");
                    setAuthError("");
                  }}
                  className="mt-3 text-sm text-slate-500 underline-offset-4 hover:text-primary hover:underline"
                >
                  忘记密码
                </button>
              )}
              {authMode === "reset" && (
                <div className="mt-4 rounded-2xl bg-sky-50 px-4 py-3 text-sm leading-6 text-primary">
                  请联系邀请你加入内测的管理员获取一次性重置码。重置码 30 分钟内有效。
                </div>
              )}
              <form onSubmit={onAuth} className="mt-5 space-y-3">
                {authMode === "register" && (
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    aria-label="昵称"
                    placeholder="怎么称呼你"
                    autoComplete="name"
                    maxLength={30}
                    required
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                  />
                )}
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  aria-label="邮箱"
                  placeholder="邮箱"
                  autoComplete="email"
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  aria-label="密码"
                  placeholder={authMode === "login" ? "密码" : "设置新密码，至少 8 位"}
                  autoComplete={authMode === "login" ? "current-password" : "new-password"}
                  minLength={8}
                  maxLength={128}
                  required
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                />
                {(authMode === "register" || authMode === "reset") && (
                  <>
                    <input
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      type="password"
                      aria-label="再次输入密码"
                      placeholder="再次输入密码"
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                    />
                    {authMode === "register" && inviteRequired && (
                      <div>
                        <input
                          value={registrationCode}
                          onChange={(e) => setRegistrationCode(e.target.value.toUpperCase())}
                          aria-label="邀请码"
                          placeholder="邀请码"
                          autoComplete="off"
                          maxLength={11}
                          required
                          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-semibold uppercase tracking-widest outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                        />
                        <p className="mt-1.5 px-1 text-xs leading-5 text-slate-400">
                          {partnerInviteFromLink
                            ? "这是伴侣邀请。创建账号后会先向对方发出绑定申请，对方确认后才会建立双人空间。"
                            : "DeepWe 当前为邀请制内测，每个邀请码只能使用一次。"}
                        </p>
                      </div>
                    )}
                    {authMode === "reset" && (
                      <input
                        value={passwordResetCode}
                        onChange={(e) => setPasswordResetCode(e.target.value.toUpperCase())}
                        aria-label="密码重置码"
                        placeholder="一次性密码重置码"
                        autoComplete="off"
                        required
                        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-semibold uppercase tracking-widest outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                      />
                    )}
                  </>
                )}
                <button
                  type="submit"
                  disabled={authBusy}
                  className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-60"
                >
                  {authBusy
                    ? "请稍候…"
                    : authMode === "login"
                      ? "登录"
                      : authMode === "register"
                        ? "创建账号"
                        : "重置密码"}
                </button>
              </form>
              {authMode === "reset" && (
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode("login");
                    setAuthError("");
                  }}
                  className="mt-3 w-full text-center text-sm text-slate-500 hover:text-primary"
                >
                  返回登录
                </button>
              )}
              {authError && <p className="mt-3 text-center text-sm text-rose-600">{authError}</p>}
            </section>
          )}

          {account && (
            <div className={styles.appShell}>
              <nav
                className={`${styles.appNav} ${appSectionVisible ? styles.appNavVisible : ""}`}
                aria-label="主要功能"
              >
                <div className={styles.desktopNavBrand}>
                  <BrandLockup className={styles.desktopNavWordmark} />
                  <span>一起走进关系深处</span>
                </div>
                <Link href="/app" className={styles.appNavItem} aria-label="私密对话">
                  <span className={styles.appNavIconWrap}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z" />
                    </svg>
                  </span>
                  <span>私密对话</span>
                </Link>
                {(Object.keys(APP_TABS) as AppTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveAppTab(tab)}
                    className={`${styles.appNavItem} ${activeAppTab === tab ? styles.appNavItemActive : ""}`}
                    aria-current={activeAppTab === tab ? "page" : undefined}
                  >
                    <span className={styles.appNavIconWrap}>
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d={APP_TABS[tab].path} />
                      </svg>
                      {tab === "couple" && !!partnerOverview?.eventInvites.length && (
                        <span className={styles.appNavBadge}>{partnerOverview.eventInvites.length}</span>
                      )}
                    </span>
                    <span>{APP_TABS[tab].label}</span>
                  </button>
                ))}
              </nav>

              <div className={styles.appContent}>
                <header className={styles.appPageHeader}>
                  <div>
                    <BrandLockup className={styles.appWordmark} />
                    <h2>
                      {activeAppTab === "couple" && "双人空间"}
                      {activeAppTab === "records" && "复盘记录"}
                      {activeAppTab === "me" && "我的账号"}
                    </h2>
                    <p>
                      {activeAppTab === "couple" && "连接、邀请与双方共同确认的内容都在这里。"}
                      {activeAppTab === "records" && "继续过去的潜谈，或回望已经完成的复盘。"}
                      {activeAppTab === "me" && "管理账号、隐私与内测功能。"}
                    </p>
                  </div>
                  {account.isOwner && activeAppTab === "me" && (
                    <span className={styles.adminPill}>管理员</span>
                  )}
                </header>

              {!account.analyticsNoticeSeen && (
                <section className="mb-3 rounded-2xl bg-sky-50 px-4 py-3 ring-1 ring-sky-100" aria-label="体验数据说明">
                  <p className="text-sm font-medium text-slate-800">关于体验数据</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    为了发现等待过久或流程卡住的位置，我们只记录页面步骤、停留时间、错误和模型 token 用量；不会记录聊天内容、摘要、邀请码、键盘输入或录屏。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onDismissAnalyticsNotice(false)}
                      disabled={analyticsBusy}
                      className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
                    >
                      知道了
                    </button>
                    <button
                      type="button"
                      onClick={() => onDismissAnalyticsNotice(true)}
                      disabled={analyticsBusy}
                      className="rounded-full bg-white px-4 py-2 text-xs text-slate-600 ring-1 ring-slate-200 disabled:opacity-50"
                    >
                      查看隐私设置
                    </button>
                  </div>
                </section>
              )}

              {activeAppTab === "me" && (
                <section className={styles.productCard + " mb-3 p-5"}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-slate-900">{account.displayName}</h3>
                      <p className="truncate text-xs text-slate-500">{account.email}</p>
                    </div>
                    <button type="button" onClick={onLogout} disabled={authBusy} className="shrink-0 text-sm text-slate-500 disabled:opacity-50">
                      退出登录
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen((current) => !current)}
                    className="mt-4 w-full rounded-full border border-slate-200 py-2.5 text-sm text-slate-600"
                  >
                    {settingsOpen ? "收起账号设置" : "密码与数据设置"}
                  </button>
                  <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-700">帮助改进使用体验</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        不采集聊天内容。关闭后停止记录，并删除你已有的原始体验数据。
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={account.analyticsEnabled}
                      aria-label="帮助改进使用体验"
                      onClick={() => onToggleAnalytics(!account.analyticsEnabled)}
                      disabled={analyticsBusy}
                      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                        account.analyticsEnabled ? "bg-primary" : "bg-slate-300"
                      }`}
                    >
                      <span
                        className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                          account.analyticsEnabled ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                  {settingsOpen && <div className="mt-4 border-t border-slate-100 pt-4">
                  <form onSubmit={onChangePassword} className="space-y-2">
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="当前密码"
                      required
                      className="w-full rounded-2xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-primary"
                    />
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="新密码，至少 8 位"
                      minLength={8}
                      required
                      className="w-full rounded-2xl border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-primary"
                    />
                    <button
                      type="submit"
                      disabled={settingsBusy}
                      className="w-full rounded-full bg-primary py-2.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      修改密码
                    </button>
                  </form>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={onExportData}
                      disabled={settingsBusy}
                      className="rounded-full border border-slate-200 py-2.5 text-sm text-slate-600 disabled:opacity-50"
                    >
                      导出我的数据
                    </button>
                    <button
                      type="button"
                      onClick={onLogoutAll}
                      disabled={settingsBusy}
                      className="rounded-full border border-slate-200 py-2.5 text-sm text-slate-600 disabled:opacity-50"
                    >
                      退出所有设备
                    </button>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-400">导出文件不会包含对方的私密潜谈。</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsMessage("");
                      setDeleteAccountOpen(true);
                    }}
                    disabled={settingsBusy || account.isOwner === true}
                    className="mt-4 w-full rounded-full py-2.5 text-sm text-rose-600 hover:bg-rose-50 disabled:text-[#b99da3]"
                  >
                    {account.isOwner ? "唯一管理员账号不可注销" : "注销账号并删除我的数据"}
                  </button>
                  {settingsMessage && <p className="mt-3 text-sm text-slate-600">{settingsMessage}</p>}
                  </div>}
                </section>
              )}

              {activeAppTab === "couple" && <section className={styles.productCard + " mb-3 overflow-hidden p-5"}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">双人空间</h3>
                      {partnerOverview?.connection && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                          {partnerOverview.connection.status === "paused" ? "已暂停" : partnerOverview.connection.status === "disconnecting" ? "解绑处理中" : "已连接"}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      连接伴侣后，可以直接邀请对方参与复盘，不必每次传邀请码。
                    </p>
                  </div>
                  {partnerOverview?.connection && (
                    <button
                      type="button"
                      aria-label="双人空间设置"
                      onClick={() => setPartnerSettingsOpen((current) => !current)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-lg leading-none text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                    >
                      ···
                    </button>
                  )}
                </div>

                {!partnerOverview && (
                  <p className="mt-4 text-sm text-slate-400">正在进入双人空间…</p>
                )}

                {partnerOverview?.connection && (
                  <>
                    <div className="mt-4 rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 px-4 py-4">
                      <p className="text-xs text-slate-500">你的伴侣</p>
                      <p className="mt-1 text-lg font-semibold text-slate-800">
                        {partnerOverview.connection.partner.displayName}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        自 {new Date(partnerOverview.connection.createdAt).toLocaleDateString("zh-CN")} 起连接
                      </p>
                      {partnerOverview.connection.status === "paused" && (
                        <p className="mt-2 text-xs text-amber-700">共同互动已暂停至 {new Date(partnerOverview.connection.pausedUntil!).toLocaleString("zh-CN")}</p>
                      )}
                      {partnerOverview.connection.status === "disconnecting" && (
                        <p className="mt-2 text-xs leading-5 text-rose-700">共同互动已停止，解绑将在 {new Date(partnerOverview.connection.disconnectEffectiveAt!).toLocaleString("zh-CN")} 生效。</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={onToggleSharedSpace}
                      disabled={sharedSpaceBusy}
                      className="mt-3 w-full rounded-full border border-sky-200 bg-white py-2.5 text-sm font-medium text-primary transition hover:bg-sky-50 disabled:opacity-50"
                    >
                      {sharedSpaceOpen ? "收起共同空间" : "进入共同空间"}
                    </button>
                    {sharedSpaceOpen && (
                      <div className="mt-3 rounded-3xl border border-sky-100 bg-sky-50/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h4 className="text-sm font-semibold text-slate-800">双方共同确认</h4>
                            <p className="mt-1 text-xs leading-5 text-slate-500">
                              只有你们两人都同意的内容才会留在这里；个人潜谈永远不会自动进入。
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[10px] text-sky-700">
                            共同空间
                          </span>
                        </div>
                        {partnerOverview.connection.status !== "active" && (
                          <p className="mt-3 rounded-2xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                            当前可以查看已经确认的共同内容，但暂停或解绑处理中不能新增、修改或确认。
                          </p>
                        )}

                        {sharedSpaceBusy && !sharedSpace && (
                          <p className="mt-4 text-sm text-slate-400">正在加载…</p>
                        )}

                        {!!sharedSpace?.memories.length && (
                          <div className="mt-4 space-y-2">
                            {sharedSpace.memories.map((memory) => (
                              <div key={memory.id} className="rounded-2xl border border-emerald-100 bg-white px-4 py-3">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-medium text-emerald-700">
                                    {SHARED_MEMORY_LABEL[memory.category]}
                                  </p>
                                  <span className="text-[10px] text-emerald-600">双方已确认</span>
                                </div>
                                <p className="mt-2 text-sm leading-6 text-slate-700">{memory.content}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {sharedSpace && !sharedSpace.memories.length && !sharedSpace.proposals.length && (
                          <p className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm leading-6 text-slate-500">
                            这里还是空的。可以从一条具体的沟通方式开始，不需要一次写得很完整。
                          </p>
                        )}

                        {!!sharedSpace?.proposals.length && (
                          <div className="mt-4">
                            <p className="text-xs font-medium text-slate-500">待双方处理</p>
                            <div className="mt-2 space-y-2">
                              {sharedSpace.proposals.map((proposal) => (
                                <div key={proposal.id} className="rounded-2xl border border-amber-100 bg-white px-4 py-3">
                                  <div className="flex items-start justify-between gap-2">
                                    <div>
                                      <p className="text-xs font-medium text-amber-700">
                                        {SHARED_MEMORY_LABEL[proposal.category]}
                                      </p>
                                      <p className="mt-1 text-[11px] text-[#7f6d68]">
                                        {proposal.updatedByName}最后修改
                                      </p>
                                    </div>
                                    <span className={`rounded-full px-2 py-1 text-[10px] ${proposal.status === "rejected" ? "bg-slate-100 text-slate-500" : "bg-amber-50 text-amber-700"}`}>
                                      {proposal.status === "rejected"
                                        ? "暂未同意"
                                        : proposal.myConfirmed
                                          ? "等待对方"
                                          : "等待你确认"}
                                    </span>
                                  </div>
                                  <p className="mt-2 text-sm leading-6 text-slate-700">{proposal.content}</p>
                                  {proposal.previousContent && (
                                    <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
                                      <p>当前生效版本：{proposal.previousContent}</p>
                                      <p className="mt-1">待确认新版本：v{proposal.nextVersion}</p>
                                    </div>
                                  )}
                                  {proposal.rejectionReason && (
                                    <p className="mt-2 text-xs leading-5 text-slate-500">
                                      暂未同意的原因：{proposal.rejectionReason}
                                    </p>
                                  )}
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {proposal.status === "pending" && !proposal.myConfirmed && (
                                      <button
                                        type="button"
                                        onClick={() => onConfirmSharedProposal(proposal.id, proposal.version)}
                                        disabled={sharedSpaceBusy || partnerOverview.connection?.status !== "active"}
                                        className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
                                      >
                                        我同意这条
                                      </button>
                                    )}
                                    {proposal.proposedByMe && <button
                                      type="button"
                                      onClick={() => onEditSharedProposal(proposal)}
                                      disabled={sharedSpaceBusy || partnerOverview.connection?.status !== "active"}
                                      className="rounded-full border border-slate-200 px-4 py-2 text-xs text-slate-600 disabled:opacity-50"
                                    >
                                      {proposal.status === "rejected" ? "修改后重新提出" : "提出修改"}
                                    </button>}
                                    {proposal.status === "pending" && (
                                      <button
                                        type="button"
                                        onClick={() => onRejectSharedProposal(proposal.id)}
                                        disabled={sharedSpaceBusy || partnerOverview.connection?.status !== "active"}
                                        className="rounded-full px-3 py-2 text-xs text-slate-400 disabled:opacity-50"
                                      >
                                        {proposal.proposedByMe ? "撤回" : "暂不同意"}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {sharedProposalOpen ? (
                          <form onSubmit={onSubmitSharedProposal} className="mt-4 rounded-2xl border border-sky-100 bg-white p-3">
                            <select
                              value={sharedProposalCategory}
                              onChange={(event) => setSharedProposalCategory(event.target.value as SharedMemoryCategory)}
                              disabled={!!editingSharedProposalId}
                              aria-label="共同内容主题"
                              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-primary disabled:bg-slate-50"
                            >
                              {Object.entries(SHARED_MEMORY_LABEL).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            <textarea
                              value={sharedProposalContent}
                              onChange={(event) => setSharedProposalContent(event.target.value.slice(0, 300))}
                              placeholder="写一条具体、双方都能判断是否同意的内容…"
                              rows={3}
                              className="mt-2 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm leading-6 text-slate-700 outline-none focus:border-primary"
                            />
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                onClick={resetSharedProposalForm}
                                className="flex-1 rounded-full border border-slate-200 py-2 text-sm text-slate-500"
                              >
                                取消
                              </button>
                              <button
                                type="submit"
                                disabled={sharedSpaceBusy || partnerOverview.connection.status !== "active" || !sharedProposalContent.trim()}
                                className="flex-1 rounded-full bg-primary py-2 text-sm font-medium text-white disabled:opacity-40"
                              >
                                {editingSharedProposalId ? "重新提交确认" : "提交给双方确认"}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSharedProposalOpen(true)}
                            disabled={sharedSpaceBusy || partnerOverview.connection.status !== "active" || !sharedSpace}
                            className="mt-4 w-full rounded-full bg-primary py-2.5 text-sm font-medium text-white disabled:opacity-40"
                          >
                            提出一条共同内容
                          </button>
                        )}
                        {sharedSpaceError && (
                          <p className="mt-3 text-sm text-rose-600">{sharedSpaceError}</p>
                        )}
                      </div>
                    )}
                    {partnerSettingsOpen && (
                      <div className="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
                        {partnerOverview.connection.status === "active" && (
                          <div className="mb-2 grid grid-cols-3 gap-2">
                            {([1, 3, 7] as const).map((days) => (
                              <button key={days} type="button" disabled={partnerBusy} onClick={() => runPartnerAction(() => pausePartnerConnection(days), `共同互动已暂停 ${days} 天`)} className="rounded-full border border-slate-200 bg-white py-2 text-xs text-slate-600">暂停{days}天</button>
                            ))}
                          </div>
                        )}
                        {partnerOverview.connection.status === "paused" && partnerOverview.connection.pausedByMe && (
                          <button type="button" disabled={partnerBusy} onClick={() => runPartnerAction(resumePartnerConnection, "共同互动已恢复")} className="mb-2 w-full rounded-full border border-emerald-200 bg-white py-2 text-sm text-emerald-700">提前恢复</button>
                        )}
                        {partnerOverview.connection.status === "disconnecting" && partnerOverview.connection.disconnectRequestedByMe && (
                          <button type="button" disabled={partnerBusy} onClick={() => runPartnerAction(cancelPartnerDisconnect, "已撤销解绑，伴侣连接恢复")} className="mb-2 w-full rounded-full border border-emerald-200 bg-white py-2 text-sm text-emerald-700">撤销解绑</button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setPartnerError("");
                            setPartnerDisconnectOpen(true);
                          }}
                          disabled={partnerBusy || partnerOverview.connection.status === "disconnecting"}
                          className="w-full rounded-full py-2 text-sm text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                        >
                          {partnerOverview.connection.status === "disconnecting" ? "解绑处理中" : "解绑伴侣"}
                        </button>
                      </div>
                    )}
                  </>
                )}

                {partnerOverview && !partnerOverview.connection && (
                  <div className="mt-4">
                    {partnerOverview.bindingRequest && (
                      <div className="mb-3 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-4">
                        <p className="text-sm font-medium text-slate-800">
                          {partnerOverview.bindingRequest.direction === "incoming" ? `${partnerOverview.bindingRequest.counterpart.displayName} 申请与你绑定` : `等待 ${partnerOverview.bindingRequest.counterpart.displayName} 确认`}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">确认后双方将成为唯一绑定伴侣；私密聊天和个人偏好仍不会共享。</p>
                        <div className="mt-3 flex gap-2">
                          {partnerOverview.bindingRequest.direction === "incoming" && <button type="button" disabled={partnerBusy} onClick={() => runPartnerAction(() => approvePartnerBinding(partnerOverview.bindingRequest!.id), "伴侣绑定已确认")} className="flex-1 rounded-full bg-primary py-2 text-sm text-white">确认绑定</button>}
                          <button type="button" disabled={partnerBusy} onClick={() => runPartnerAction(() => cancelPartnerBinding(partnerOverview.bindingRequest!.id), "绑定申请已取消")} className="flex-1 rounded-full border border-slate-200 bg-white py-2 text-sm text-slate-600">取消申请</button>
                        </div>
                      </div>
                    )}
                    {partnerOverview.archivedConnection && pageOpenedAt < partnerOverview.archivedConnection.recoverableUntil && (
                      <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                        <p className="text-sm font-medium text-slate-800">与 {partnerOverview.archivedConnection.partner.displayName} 的关系档案</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">解绑后 30 天内，双方可以重新连接，并共同决定是否恢复旧共同空间。</p>
                        {partnerOverview.archivedConnection.recoveryRequestedByPartner ? (
                          <button type="button" disabled={partnerBusy} onClick={() => runPartnerAction(() => approvePartnerRecovery(partnerOverview.archivedConnection!.id), "伴侣连接已恢复")} className="mt-3 w-full rounded-full bg-primary py-2 text-sm text-white">同意重新连接</button>
                        ) : (
                          <button type="button" disabled={partnerBusy || partnerOverview.archivedConnection.recoveryRequestedByMe} onClick={() => runPartnerAction(() => requestPartnerRecovery(partnerOverview.archivedConnection!.id, window.confirm("是否同时申请恢复过去双方确认的共同记忆？取消则只重新绑定，不恢复旧共同记忆。")), "恢复申请已发给对方")} className="mt-3 w-full rounded-full border border-slate-200 bg-white py-2 text-sm text-slate-600 disabled:opacity-50">{partnerOverview.archivedConnection.recoveryRequestedByMe ? "等待对方确认" : "申请重新连接"}</button>
                        )}
                      </div>
                    )}
                    {!partnerOverview.bindingRequest && (partnerOverview.outgoingInvite?.status === "pending" ? (
                      <div className="rounded-2xl border border-sky-100 bg-sky-50 px-4 py-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs text-slate-500">伴侣连接码</p>
                            <p className="mt-1 font-mono text-lg font-semibold tracking-wider text-slate-800">
                              {partnerOverview.outgoingInvite.code}
                            </p>
                          </div>
                          <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] text-amber-700">
                            等待加入
                          </span>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-slate-500">
                          这份邀请也可以让尚未注册的伴侣直接创建账号。连接码 7 天内有效，只能由一人使用。
                        </p>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            onClick={onCopyPartnerInvite}
                            className="flex-1 rounded-full bg-primary py-2.5 text-sm font-medium text-white"
                          >
                            {copiedPartnerInvite ? "邀请已复制" : "复制邀请"}
                          </button>
                          <button
                            type="button"
                            onClick={onRevokePartnerInvite}
                            disabled={partnerBusy}
                            className="rounded-full border border-slate-200 px-4 py-2.5 text-sm text-slate-500 disabled:opacity-50"
                          >
                            撤回
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={onCreatePartnerInvite}
                        disabled={partnerBusy}
                        className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-50"
                      >
                        {partnerBusy ? "正在准备…" : partnerOverview.outgoingInvite?.status === "expired" ? "重新邀请伴侣" : "邀请伴侣加入"}
                      </button>
                    ))}

                    {!partnerOverview.bindingRequest && <button
                      type="button"
                      onClick={() => setPartnerJoinOpen((current) => !current)}
                      className="mt-3 w-full py-2 text-center text-sm text-slate-500 hover:text-primary"
                    >
                      我有伴侣连接码
                    </button>}
                    {!partnerOverview.bindingRequest && (partnerJoinOpen || partnerInviteFromLink) && (
                      <form onSubmit={onAcceptPartnerInvite} className="mt-2 flex gap-2">
                        <input
                          value={partnerCode}
                          onChange={(event) => setPartnerCode(event.target.value.toUpperCase())}
                          aria-label="伴侣连接码"
                          placeholder="输入伴侣连接码"
                          maxLength={11}
                          required
                          className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-center text-sm font-semibold uppercase tracking-widest outline-none focus:border-primary"
                        />
                        <button
                          type="submit"
                          disabled={partnerBusy || partnerCode.replace(/[^A-Z0-9]/g, "").length !== 10}
                          className="shrink-0 rounded-full border border-primary px-4 py-2.5 text-sm font-medium text-primary disabled:opacity-40"
                        >
                          连接
                        </button>
                      </form>
                    )}
                  </div>
                )}

                {!!partnerOverview?.eventInvites.length && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <h4 className="text-sm font-semibold text-slate-800">复盘邀请</h4>
                    <div className="mt-3 space-y-2">
                      {partnerOverview.eventInvites.map((invite) => (
                        <div key={invite.id} className="rounded-2xl border border-sky-100 bg-sky-50/70 px-4 py-3">
                          <p className="text-sm font-medium text-slate-800">{invite.title}</p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">
                            {invite.inviterName} 邀请你一起复盘。开始后，你会先进入自己的私密潜谈。
                          </p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">拒绝只结束这次邀请，不会删除你已有的私密对话或内容。</p>
                          {invite.snoozed && <p className="mt-1 text-[11px] text-amber-700">已选择“晚点再聊”，邀请会保留到 {new Date(invite.expiresAt).toLocaleDateString("zh-CN")}</p>}
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              onClick={() => onAcceptPartnerEvent(invite.id)}
                              disabled={partnerBusy}
                              className="flex-1 rounded-full bg-primary py-2 text-sm font-medium text-white disabled:opacity-50"
                            >
                              现在开始
                            </button>
                            {!invite.snoozed && <button
                              type="button"
                              onClick={() => onSnoozePartnerEvent(invite.id)}
                              disabled={partnerBusy}
                              className="flex-1 rounded-full border border-slate-200 bg-white py-2 text-sm text-slate-500 disabled:opacity-50"
                            >
                              晚点再聊
                            </button>}
                          </div>
                          <button
                            type="button"
                            onClick={() => void runPartnerAction(() => declineEvent(invite.id), "已拒绝这次邀请。你的私密对话和内容仍会保留。")}
                            disabled={partnerBusy}
                            className="mt-2 w-full rounded-full border border-slate-200 bg-white py-2 text-sm text-slate-600 disabled:opacity-50"
                          >
                            拒绝这次邀请
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-400">
                  连接不会开放你们各自的私密潜谈。共同内容只有双方确认后才会生效。
                </p>
                {partnerError && <p className="mt-3 text-sm text-rose-600">{partnerError}</p>}
              </section>}

              {activeAppTab === "me" && account.isOwner && <AdminAnalyticsPanel />}

              {activeAppTab === "me" && account.isOwner && (
                <section className={styles.productCard + " mb-3 p-5"}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                    <h3 className="text-sm font-semibold text-slate-900">内测注册邀请</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      只有你可以生成。每个邀请码限一人注册，7 天后自动失效。状态每 10 秒自动更新。
                    </p>
                    </div>
                    <button
                      type="button"
                      onClick={onRefreshRegistrationInvites}
                      disabled={adminRefreshing}
                      className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-sky-200 hover:text-primary disabled:opacity-50"
                    >
                      {adminRefreshing ? "刷新中…" : "刷新状态"}
                    </button>
                  </div>
                  <form onSubmit={onCreateRegistrationInvite} className="mt-4 flex gap-2">
                    <input
                      value={inviteNote}
                      onChange={(e) => setInviteNote(e.target.value)}
                      aria-label="邀请码备注"
                      placeholder="备注，例如：邀请小林"
                      maxLength={60}
                      className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-accent/40"
                    />
                    <button
                      type="submit"
                      disabled={adminBusy}
                      className="shrink-0 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      生成邀请码
                    </button>
                  </form>
                  {adminError && <p className="mt-3 text-xs text-rose-600">{adminError}</p>}
                  {adminInvites.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {adminInvites.map((invite) => {
                        const available = invite.status === "unused";
                        const statusText =
                          invite.status === "used"
                            ? "已激活"
                            : invite.status === "revoked"
                              ? "已撤回"
                              : invite.status === "expired"
                                ? "已过期"
                                : "未激活";
                        const statusStyle =
                          invite.status === "used"
                            ? "bg-emerald-100 text-emerald-700"
                            : invite.status === "unused"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-slate-200 text-slate-600";
                        return (
                          <div
                            key={invite.id}
                            className="rounded-2xl border border-slate-100 bg-slate-50 px-3 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-mono text-base font-semibold tracking-wider text-slate-800">
                                    {invite.code}
                                  </p>
                                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyle}`}>
                                    {statusText}
                                  </span>
                                </div>
                                <p className="mt-0.5 truncate text-xs text-slate-400">
                                  {invite.note || "未填写备注"}
                                  {invite.status === "used" && invite.usedByDisplayName
                                    ? ` · ${invite.usedByDisplayName} 已完成注册`
                                    : ""}
                                  {invite.status === "used" && invite.usedAt
                                    ? ` · ${new Date(invite.usedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                                    : ""}
                                </p>
                              </div>
                              {available && (
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => copyRegistrationInvite(invite)}
                                    className="rounded-full px-2.5 py-1.5 text-xs text-primary hover:bg-sky-100"
                                  >
                                    {copiedInviteId === invite.id ? "已复制" : "复制"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => onRevokeRegistrationInvite(invite.id)}
                                    disabled={adminBusy}
                                    className="rounded-full px-2.5 py-1.5 text-xs text-muted hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                                  >
                                    撤回
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="mt-5 border-t border-slate-100 pt-4">
                    <h4 className="text-sm font-medium text-slate-800">账号密码重置</h4>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      用户忘记密码时，为其生成一枚 30 分钟有效的一次性重置码。
                    </p>
                    <div className="mt-3 space-y-2">
                      {adminUsers.filter((user) => user.id !== account.id).map((user) => (
                        <div key={user.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-slate-700">{user.displayName}</div>
                            <div className="truncate text-xs text-slate-400">{user.email}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => onGeneratePasswordReset(user)}
                            disabled={adminBusy}
                            className="ml-3 shrink-0 rounded-full px-3 py-1.5 text-xs text-primary hover:bg-sky-100 disabled:opacity-50"
                          >
                            生成重置码
                          </button>
                        </div>
                      ))}
                    </div>
                    {generatedReset && (
                      <div className="mt-3 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">
                        <div>{generatedReset.name} 的一次性重置码</div>
                        <div className="mt-1 font-mono text-lg font-semibold tracking-wider">{generatedReset.code}</div>
                        <div className="mt-1 text-xs text-amber-700">请私下发送给本人；使用一次后立即失效。</div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {activeAppTab === "records" && myEvents.length > 0 && (
                <section className={styles.productCard + " mb-3 p-5"}>
                  <h3 className="text-sm font-semibold text-slate-900">继续之前的对话</h3>
                  <div className="mt-3 space-y-2">
                    {(showAllEvents ? myEvents : myEvents.slice(0, 5)).map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center rounded-2xl border border-slate-100 bg-slate-50 transition hover:border-sky-200 hover:bg-sky-50"
                      >
                        <Link
                          href={`/e/${item.id}`}
                          className="flex min-w-0 flex-1 items-center justify-between px-4 py-3"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-slate-800">
                              {item.title}
                            </span>
                            <span className="mt-0.5 block text-xs text-slate-400">
                              {item.role === "a" ? "我发起的" : "我加入的"} · {new Date(item.createdAt).toLocaleDateString("zh-CN")}
                            </span>
                          </span>
                          <span className="ml-3 shrink-0 text-xs text-primary">
                            {EVENT_STATE_LABEL[item.state] ?? "继续"}
                          </span>
                        </Link>
                        <button
                          type="button"
                          onClick={() => {
                            setPendingRename(item);
                            setRenameTitle(item.title);
                            setRenameError("");
                          }}
                          className="shrink-0 rounded-full px-2.5 py-2 text-xs text-muted transition hover:bg-sky-50 hover:text-primary"
                          aria-label={`重命名“${item.title}”`}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError("");
                            setPendingDelete(item);
                          }}
                          className="mr-2 shrink-0 rounded-full px-2.5 py-2 text-xs text-muted transition hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`删除“${item.title}”`}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                  {myEvents.length > 5 && (
                    <button
                      type="button"
                      onClick={() => setShowAllEvents((current) => !current)}
                      className="mt-3 w-full py-1 text-center text-xs text-slate-500 underline-offset-4 hover:underline"
                    >
                      {showAllEvents ? "收起" : `查看全部 ${myEvents.length} 条`}
                    </button>
                  )}
                </section>
              )}

              {activeAppTab === "records" && myEvents.length === 0 && (
                <section className={styles.productCard + " p-6 text-center"}>
                  <p className="text-sm text-slate-500">这里还没有对话记录。</p>
                  <Link href="/app" className="mt-3 inline-block text-sm font-medium text-primary">开始私密对话</Link>
                </section>
              )}
              </div>
            </div>
          )}

          <p className={styles.productFooter + " text-center text-xs leading-relaxed"}>
            DeepWe深蓝陪你梳理关系中的感受与沟通，但不能替代专业心理咨询、医疗诊断或紧急援助。
            如果你正经历暴力威胁、自伤念头，或持续而强烈的心理困扰，请优先向现实中的心理咨询师、医生、当地紧急服务或你信任的人寻求帮助。
          </p>
        </div>
      </section>

      {partnerDisconnectOpen && partnerOverview?.connection && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="partner-disconnect-title"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h2 id="partner-disconnect-title" className="text-lg font-semibold text-slate-900">
              确认解除与 {partnerOverview.connection.partner.displayName} 的伴侣连接？
            </h2>
            <div className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
              <p>确认后会立即停止新的双人互动，对方也会看到“解绑处理中”。</p>
              <p className="rounded-2xl bg-amber-50 px-3 py-2.5 text-amber-800">
                你有 24 小时可以撤销。到期后连接才会正式解除。
              </p>
              <p>双方确认过的共同内容之后会成为只读档案，不会自动带入未来的新关系；你们各自的私密聊天始终只归本人。</p>
              <p className="text-slate-500">如果你只是暂时需要一点距离，可以先取消，再选择暂停 1、3 或 7 天。</p>
            </div>
            {partnerError && <p className="mt-3 text-sm text-rose-600">{partnerError}</p>}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setPartnerDisconnectOpen(false)}
                disabled={partnerBusy}
                className="flex-1 rounded-full border border-slate-200 py-3 text-sm font-medium text-slate-600 disabled:opacity-50"
              >
                先不解绑
              </button>
              <button
                type="button"
                onClick={onEndPartnerConnection}
                disabled={partnerBusy}
                className="flex-1 rounded-full bg-rose-600 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
              >
                {partnerBusy ? "处理中…" : "进入 24 小时冷静期"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteAccountOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-5 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-slate-900">确认注销账号？</h2>
            <div className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
              <p>你的账号、私密聊天和个人总结将永久删除。</p>
              <p>对方的私密聊天和双方已确认的共同结果会按双人权限保留。共同结果的永久删除需要双方确认。</p>
              <p className="font-medium text-rose-600">此操作无法恢复，建议先导出数据。</p>
            </div>
            <input
              type="password"
              value={deleteAccountPassword}
              onChange={(e) => setDeleteAccountPassword(e.target.value)}
              placeholder="输入密码确认注销"
              autoFocus
              className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-rose-400"
            />
            {settingsMessage && <p className="mt-2 text-sm text-rose-600">{settingsMessage}</p>}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setDeleteAccountOpen(false);
                  setDeleteAccountPassword("");
                  setSettingsMessage("");
                }}
                disabled={settingsBusy}
                className="flex-1 rounded-full border border-slate-200 py-2.5 text-sm text-slate-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={onDeleteAccount}
                disabled={settingsBusy || !deleteAccountPassword}
                className="flex-1 rounded-full bg-rose-600 py-2.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {settingsBusy ? "注销中…" : "永久注销"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRename && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-5 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-slate-900">修改对话名称</h2>
            <input
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              maxLength={80}
              autoFocus
              className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-primary"
            />
            {renameError && <p className="mt-2 text-sm text-rose-600">{renameError}</p>}
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => setPendingRename(null)} disabled={renameBusy} className="flex-1 rounded-full border border-slate-200 py-2.5 text-sm text-slate-600">
                取消
              </button>
              <button type="button" onClick={onConfirmRename} disabled={renameBusy || !renameTitle.trim()} className="flex-1 rounded-full bg-primary py-2.5 text-sm font-medium text-white disabled:opacity-50">
                {renameBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-5 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            <h2 id="delete-dialog-title" className="text-lg font-semibold text-slate-900">
              {pendingDelete.hasPartner ? "如何处理这次共同复盘？" : "永久删除这次潜谈？"}
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {pendingDelete.hasPartner
                ? `你可以只把“${pendingDelete.title}”从自己的列表移除，不影响对方；永久删除共同结果需要双方确认。`
                : `“${pendingDelete.title}”中的原始对话、AI 整理和相关结果都会被永久删除，无法恢复。`}
            </p>
            {pendingDelete.hasPartner && (
              <p className="mt-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-sm leading-6 text-amber-800">
                任何一方都不能单独删除另一方的私密聊天，也不能单独永久删除共同报告。
              </p>
            )}
            {deleteError && <p className="mt-3 text-sm text-rose-600">{deleteError}</p>}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleteBusy}
                className="flex-1 rounded-full border border-slate-200 py-3 text-sm font-medium text-slate-600 disabled:opacity-50"
              >
                先保留
              </button>
              <button
                type="button"
                onClick={onConfirmDelete}
                disabled={deleteBusy}
                className="flex-1 rounded-full bg-rose-600 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
              >
                {deleteBusy ? "处理中…" : pendingDelete.hasPartner ? "仅从我的记录移除" : "永久删除"}
              </button>
            </div>
            {pendingDelete.hasPartner && (
              <button type="button" onClick={onRequestPermanentDelete} disabled={deleteBusy || pendingDelete.deletionRequestedByMe} className="mt-3 w-full rounded-full border border-rose-200 py-2.5 text-sm text-rose-600 disabled:opacity-50">
                {pendingDelete.deletionRequestedByPartner ? "确认对方的永久删除申请" : pendingDelete.deletionRequestedByMe ? "已申请，等待对方确认" : "申请双方永久删除"}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
