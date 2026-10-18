"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type {
  NvcSummary,
  MergedUnderstanding,
  EventData,
  Review,
} from "@/lib/types";
import { trackAnalytics, trackAnalyticsBestEffort } from "@/lib/analytics";
import {
  getCurrentAccount,
  confirmASummary,
  confirmBSummary,
  confirmMerged,
  chooseAgreement,
  joinEvent,
  declineEvent,
  withdrawInvite,
  sendGuideMessage,
  editGuideMessage,
  deleteGuideMessage,
  regenerateGuideReply,
  stopAiReply,
  finishGuiding,
  endGuiding,
  continueFromSummary,
  continueAfterWithdraw,
  resubmitAfterWithdraw,
  refreshExpiredEventInvite,
  retryAiJob,
  submitReview,
} from "@/lib/api";

function formatMessageTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function fullMessageTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

export default function EventView({
  data,
  onRefresh,
}: {
  data: EventData;
  onRefresh: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [correction, setCorrection] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [custom, setCustom] = useState("");
  const [showOutcomePrompt, setShowOutcomePrompt] = useState(false);
  const aiPending = data.aiJobStatus === "queued" || data.aiJobStatus === "processing";
  const aiFailed = data.aiJobStatus === "failed";
  const aiLocked = aiPending || aiFailed;
  const retryableJob = aiFailed && data.aiJobRetryAllowed && data.aiJobId && data.aiJobAttempt !== null
    ? { id: data.aiJobId, attempt: data.aiJobAttempt }
    : null;

  useEffect(() => {
    if (data.role === "guest") return;
    const step = data.state === "a_guiding" || data.state === "b_guiding"
      ? data.guideStage
      : data.state;
    const enteredAt = Date.now();
    trackAnalyticsBestEffort({
      name: "guide_stage_viewed",
      eventId: data.id,
      screen: "event",
      step,
    });
    return () => {
      trackAnalyticsBestEffort({
        name: "screen_left",
        eventId: data.id,
        screen: "event",
        step,
        durationMs: Date.now() - enteredAt,
      });
    };
  }, [data.guideStage, data.id, data.role, data.state]);

  async function run(fn: () => Promise<{ error?: string }>): Promise<{ error?: string }> {
    setBusy(true);
    setError("");
    const r = await fn();
    setBusy(false);
    if (r.error) setError(r.error);
    await onRefresh();
    return r;
  }

  return (
    <main className="deepwe-event-shell mx-auto min-h-screen w-full max-w-md px-5 py-8">
      <Header data={data} />

      {showOutcomePrompt && data.analyticsEnabled && (
        <OutcomeFeedback eventId={data.id} onDone={() => setShowOutcomePrompt(false)} />
      )}

      {data.role === "a" &&
        data.inviteStatus === "activated" &&
        (data.state === "b_guiding" || (data.state === "b_summary" && !data.bConfirmed)) && (
        <InviteActivationStatus status="activated" />
      )}

      {aiPending && data.aiJobKind !== "guide" && <AiJobProgress kind={data.aiJobKind} />}
      {aiFailed && (
        <AiJobFailure
          message={data.aiJobError}
          busy={busy}
          onRetry={retryableJob ? () =>
            run(async () => {
              const result = await retryAiJob(data.id, retryableJob.id, retryableJob.attempt);
              return result.error ? { error: result.error } : {};
            })
          : undefined}
        />
      )}

      {data.state === "safety_exit" && <SafetyExit risk={data.risk} />}
      {data.state === "declined" && <Declined />}
      {data.state === "cancelled" && (
        <Cancelled
          role={data.role}
          busy={busy}
          onContinue={() =>
            run(async () => {
              const r = await continueAfterWithdraw(data.id);
              return r.error ? { error: r.error } : {};
            })
          }
          onResubmit={() =>
            run(async () => {
              const r = await resubmitAfterWithdraw(data.id);
              return r.error ? { error: r.error } : {};
            })
          }
        />
      )}
      {data.state === "closed" && <Closed />}

      {data.state === "waiting_b" && data.role === "guest" && (
          <GuestJoin
            code={joinCode}
            setCode={setJoinCode}
            busy={busy}
            onJoin={() =>
              run(async () => {
                const r = await joinEvent(joinCode);
                if (r.error) return { error: r.error };
                return {};
              })
            }
          />
        )}

      {data.role === "guest" &&
        data.state !== "waiting_b" &&
        data.state !== "safety_exit" &&
        data.state !== "declined" &&
        data.state !== "cancelled" &&
        data.state !== "closed" && (
          <StepCard title="这次复盘当前无法加入">
            <p className="text-sm text-slate-500">邀请可能尚未发出、已经使用，或流程已经结束。</p>
          </StepCard>
        )}

      {data.role !== "guest" &&
        data.state !== "safety_exit" &&
        data.state !== "declined" &&
        data.state !== "closed" && (
          <>
            {data.state === "a_guiding" &&
              (data.role === "a" ? (
                <GuideStep
                  key={`${data.id}:${data.role}`}
                  role={data.role}
                  eventId={data.id}
                  messages={data.guideMessages}
                  busy={busy || aiPending}
                  locked={busy || aiLocked}
                  actionBusy={busy}
                  canPrepareExpression={!aiLocked}
                  readyToWrap={data.guideStage === "checkin" || data.guideStage === "review"}
                  onSend={(msg) =>
                    run(async () => {
                      const r = await sendGuideMessage(data.id, msg);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onEdit={(messageId, msg) =>
                    run(async () => {
                      const r = await editGuideMessage(data.id, messageId, msg);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  canStop={aiPending}
                  onStop={() =>
                    run(async () => {
                      const r = await stopAiReply(data.id);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onDelete={(messageId) =>
                    run(async () => {
                      const r = await deleteGuideMessage(data.id, messageId);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onRegenerate={(messageId, reason) =>
                    run(async () => {
                      const r = await regenerateGuideReply(data.id, messageId, reason);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onEnd={async () => {
                    const result = await run(async () => {
                      const r = await endGuiding(data.id);
                      return r.error ? { error: r.error } : {};
                    });
                    if (!result.error && data.analyticsEnabled) setShowOutcomePrompt(true);
                    return result;
                  }}
                  onFinish={async () => {
                    const result = await run(async () => {
                      const r = await finishGuiding(data.id);
                      return r.error ? { error: r.error } : {};
                    });
                    if (!result.error && data.analyticsEnabled) setShowOutcomePrompt(true);
                    return result;
                  }}
                />
              ) : (
                <Center note="对方正在准备…" />
              ))}

            {data.state === "b_guiding" &&
              (data.role === "b" ? (
                <GuideStep
                  key={`${data.id}:${data.role}`}
                  role={data.role}
                  eventId={data.id}
                  messages={data.guideMessages}
                  busy={busy || aiPending}
                  locked={busy || aiLocked}
                  actionBusy={busy}
                  canPrepareExpression={!aiLocked}
                  readyToWrap={data.guideStage === "checkin" || data.guideStage === "review"}
                  onDecline={() =>
                    run(async () => {
                      const r = await declineEvent(data.id);
                      return r.ok ? {} : { error: r.error };
                    })
                  }
                  onSend={(msg) =>
                    run(async () => {
                      const r = await sendGuideMessage(data.id, msg);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onEdit={(messageId, msg) =>
                    run(async () => {
                      const r = await editGuideMessage(data.id, messageId, msg);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  canStop={aiPending}
                  onStop={() =>
                    run(async () => {
                      const r = await stopAiReply(data.id);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onDelete={(messageId) =>
                    run(async () => {
                      const r = await deleteGuideMessage(data.id, messageId);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onRegenerate={(messageId, reason) =>
                    run(async () => {
                      const r = await regenerateGuideReply(data.id, messageId, reason);
                      return r.error ? { error: r.error } : {};
                    })
                  }
                  onEnd={async () => {
                    const result = await run(async () => {
                      const r = await endGuiding(data.id);
                      return r.error ? { error: r.error } : {};
                    });
                    if (!result.error && data.analyticsEnabled) setShowOutcomePrompt(true);
                    return result;
                  }}
                  onFinish={async () => {
                    const result = await run(async () => {
                      const r = await finishGuiding(data.id);
                      return r.error ? { error: r.error } : {};
                    });
                    if (!result.error && data.analyticsEnabled) setShowOutcomePrompt(true);
                    return result;
                  }}
                />
              ) : (
                <Center note="对方正在准备…" />
              ))}

            {data.state === "a_expressing" && <Center note="正在整理你的表达…" />}

            {data.state === "a_summary" &&
              (data.role === "a" ? (
                data.aSummary ? (
                  <SummaryEditor
                    s={data.aSummary}
                    busy={busy || aiLocked}
                    onContinueTalking={() =>
                      run(async () => {
                        const r = await continueFromSummary(data.id);
                        return r.error ? { error: r.error } : {};
                      })
                    }
                    onConfirm={(edited) =>
                      run(async () => {
                        if (!window.confirm("确认后，这份由你审核过的摘要才会用于邀请伴侣。你的原始聊天、个人偏好和未确认内容不会分享。继续吗？")) return {};
                        const r = await confirmASummary(data.id, edited);
                        return r.error ? { error: r.error } : {};
                      })
                    }
                  />
                ) : (
                  <Center note="正在生成摘要…" />
                )
              ) : (
                <Center note="对方正在准备…" />
              ))}

            {data.state === "waiting_b" &&
              (data.role === "a" ? (
                <StepCard
                  title={
                    data.inviteStatus === "expired"
                      ? "这次邀请已经过期"
                      : data.partnerTarget
                        ? `已邀请 ${data.partnerTarget.displayName}`
                        : "先绑定伴侣，再发起双人复盘"
                  }
                  hint={
                    data.inviteStatus === "expired"
                      ? "原邀请已经失效。你的表达仍然保留，可以直接重新邀请。"
                      : data.partnerTarget
                        ? "对方会在自己的双人空间里看到邀请，并自行选择现在开始或晚点再聊。"
                        : data.inviteMode === "legacy_code"
                          ? "这是历史复盘，可继续使用原邀请码。"
                          : "当前没有已绑定伴侣。本次私密聊天仍会保留，不会自动发送给任何人。"
                  }
                >
                  {data.partnerTarget ? (
                    <div className="mb-4 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3">
                      <div className="text-sm font-semibold text-slate-800">
                        {data.inviteStatus === "expired" ? "等待重新邀请" : "等待对方回应"}
                      </div>
                      <div className="mt-1 text-xs leading-relaxed text-slate-500">
                        只有 {data.partnerTarget.displayName} 可以接受。对方接受后才会进入自己的私密潜谈。
                      </div>
                    </div>
                  ) : data.inviteMode === "legacy_code" ? (
                    <>
                      <InviteActivationStatus status={data.inviteStatus ?? "waiting"} />
                      <InviteCode code={data.code} />
                    </>
                  ) : (
                    <div className="mb-4 rounded-2xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
                      请先返回首页完成伴侣绑定。绑定后可重新提交邀请；在此之前，你可以撤回邀请并继续和 AI 私密聊。
                    </div>
                  )}
                  {data.inviteStatus === "expired" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await refreshExpiredEventInvite(data.id);
                          return r.error ? { error: r.error } : {};
                        })
                      }
                      className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
                    >
                      {data.partnerTarget ? "重新邀请伴侣" : "生成新的邀请码"}
                    </button>
                  ) : (
                    <Center note={data.partnerTarget ? "等待对方回应…（页面会自动刷新）" : "等待对方激活…（页面会自动刷新）"} />
                  )}
                  <button
                    onClick={() =>
                      run(async () => {
                        const r = await withdrawInvite(data.id);
                        return r.ok ? {} : { error: r.error };
                      })
                    }
                    className="w-full py-1 text-center text-xs text-slate-400 transition hover:text-slate-600"
                  >
                    撤回邀请
                  </button>
                </StepCard>
              ) : (
                <Center note="对方正在准备…" />
              ))}

            {data.state === "b_summary" &&
              (data.role === "b" ? (
                data.bConfirmed ? (
                  <StepCard
                    title="你的摘要已确认"
                    hint="这份表达已经提交。共同理解正在准备；如遇到生成错误，可使用上方的重试操作。"
                  >
                    <Center note={aiFailed ? "共同理解暂时没有生成完成，请查看上方提示并重试。" : "正在根据双方已确认的摘要生成共同理解…"} />
                  </StepCard>
                ) : data.bSummary ? (
                  <SummaryEditor
                    s={data.bSummary}
                    busy={busy || aiLocked}
                    confirmLabel="确认，生成共同理解"
                    onContinueTalking={() =>
                      run(async () => {
                        const r = await continueFromSummary(data.id);
                        return r.error ? { error: r.error } : {};
                      })
                    }
                    onConfirm={(edited) =>
                      run(async () => {
                        if (!window.confirm("确认后，你审核过的摘要会与对方已确认的摘要一起生成共同理解。你的原始聊天不会分享。继续吗？")) return {};
                        const r = await confirmBSummary(data.id, edited);
                        return r.error ? { error: r.error } : {};
                      })
                    }
                  />
                ) : (
                  <Center note="正在生成摘要…" />
                )
              ) : (
                <Center note="对方正在确认摘要…" />
              ))}

            {(data.state === "merged" || data.state === "ready_to_merge") && (
              <CorrectionStep data={data} correction={correction} setCorrection={setCorrection} busy={busy || aiLocked} run={run} />
            )}

            {data.state === "agreement_proposed" && (
              <AgreementStep data={data} custom={custom} setCustom={setCustom} busy={busy} run={run} />
            )}

            {data.state === "done" && <DoneStep data={data} busy={busy} run={run} />}
            {data.state === "completed" && <CompletedStep data={data} />}
          </>
        )}

      {error && <p className="mt-4 text-center text-sm text-rose-600">{error}</p>}
    </main>
  );
}

// ---------- pieces ----------

function Header({ data }: { data: EventData }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-400">DeepWe深蓝</div>
        <h1 className="text-lg font-semibold text-slate-900">{data.title}</h1>
      </div>
      <Link
        href={data.ownConversationId
          ? `/app/conversations/${encodeURIComponent(data.ownConversationId)}`
          : "/app"}
        className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-primary-soft"
      >
        {data.ownConversationId ? "回到我的私密对话" : "返回私密空间"}
      </Link>
    </header>
  );
}

function AiJobProgress({ kind }: { kind: EventData["aiJobKind"] }) {
  const text =
    kind === "summary"
      ? "正在用最高能力生成你的最终摘要…"
      : kind === "merge_initial" || kind === "merge_correction"
        ? "正在用最高能力生成双方共同理解…"
        : "正在认真理解你刚才的话…";
  return (
    <div className="mb-4 flex items-center gap-3 rounded-2xl bg-primary-soft px-4 py-3 text-sm text-primary">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span>{text} 完成后会自动出现。</span>
    </div>
  );
}

function AiJobFailure({
  message,
  busy,
  onRetry,
}: {
  message: string | null;
  busy: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="mb-4 rounded-2xl bg-rose-50 p-4 text-sm text-rose-700">
      <p>{message || "深度理解任务暂时没有完成。你的原内容已经保存。"}</p>
      {onRetry && <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="mt-3 rounded-xl bg-white px-4 py-2 font-semibold text-rose-700 ring-1 ring-rose-200 disabled:opacity-60"
      >
        继续用深度模型重试
      </button>}
    </div>
  );
}

function StepCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-[20px] bg-white p-6 ring-1 ring-slate-200">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Button({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function Center({ note }: { note: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[20px] bg-white p-10 text-center ring-1 ring-slate-200">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-slate-500">{note}</p>
    </div>
  );
}

function SummaryEditor({
  s,
  busy,
  onConfirm,
  onContinueTalking,
  confirmLabel = "确认，邀请对方",
}: {
  s: NvcSummary;
  busy: boolean;
  onConfirm: (edited: NvcSummary) => void;
  onContinueTalking: () => void;
  confirmLabel?: string;
}) {
  const [observation, setObservation] = useState(s.observation ?? "");
  const [feelings, setFeelings] = useState((s.feelings ?? []).join("、"));
  const [needs, setNeeds] = useState((s.needs ?? []).join("、"));
  const [request, setRequest] = useState(s.request ?? "");

  function submit() {
    onConfirm({
      observation: observation.trim(),
      feelings: feelings.split(/[、,，]/).map((x) => x.trim()).filter(Boolean),
      needs: needs.split(/[、,，]/).map((x) => x.trim()).filter(Boolean),
      request: request.trim(),
    });
  }

  const field =
    "w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10";
  const label = "mb-1 text-xs font-medium text-primary";

  return (
    <StepCard
      title="确认并完善你的摘要"
      hint="这是 AI 根据你们的对话整理的草稿。你可以逐项修改，让它更贴近你的意思。只有你确认的内容才会进入共同空间。"
    >
      <div className="space-y-3">
        <div>
          <div className={label}>观察（发生了什么）</div>
          <textarea
            value={observation}
            onChange={(e) => setObservation(e.target.value)}
            rows={3}
            className={`${field} resize-none`}
          />
        </div>
        <div>
          <div className={label}>感受（用顿号分隔）</div>
          <input value={feelings} onChange={(e) => setFeelings(e.target.value)} className={field} />
        </div>
        <div>
          <div className={label}>需要（用顿号分隔）</div>
          <input value={needs} onChange={(e) => setNeeds(e.target.value)} className={field} />
        </div>
        <div>
          <div className={label}>希望（你希望对方怎么做）</div>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={2}
            className={`${field} resize-none`}
          />
        </div>
      </div>
      <Button onClick={submit} disabled={busy || !observation.trim() || !request.trim()}>
        {confirmLabel}
      </Button>
      <button
        type="button"
        onClick={onContinueTalking}
        disabled={busy}
        className="w-full rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
      >
        我发现自己还没说够，回到潜谈
      </button>
    </StepCard>
  );
}

function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="flex items-center justify-between rounded-2xl bg-surface px-4 py-3">
      <div>
        <div className="text-xs text-slate-400">邀请码</div>
        <div className="text-3xl font-bold tracking-[0.3em] text-primary">{code}</div>
      </div>
      <button
        onClick={copy}
        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

function CorrectionStep({
  data,
  correction,
  setCorrection,
  busy,
  run,
}: {
  data: EventData;
  correction: string;
  setCorrection: (v: string) => void;
  busy: boolean;
  run: (fn: () => Promise<{ error?: string }>) => void;
}) {
  const mineConfirmed = data.role === "a" ? data.mergedAConfirmed : data.mergedBConfirmed;
  const otherConfirmed = data.role === "a" ? data.mergedBConfirmed : data.mergedAConfirmed;
  return (
    <StepCard
      title="共同理解（AI 合并双方摘要）"
      hint="看看 AI 对你的理解是否准确。可以纠偏让它重新生成，也可以直接确认这一版。"
    >
      {data.merged && <MergedCard m={data.merged} role={data.role} />}
      {data.merged && data.mergedVersion != null && <p className="text-xs text-slate-500">当前共同理解 · 版本 {data.mergedVersion}</p>}
      {mineConfirmed ? (
        <p className="text-sm text-emerald-600">你已确认。{otherConfirmed ? "双方都已确认。" : "等对方确认…"}</p>
      ) : (
        <>
          <textarea
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="（可选）对 AI 对你的理解纠偏：哪里太泛 / 事实有误 / 感受理解错…"
            rows={3}
            className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <div className="space-y-2">
            <Button
              disabled={busy || !correction.trim()}
              onClick={() =>
                run(async () => {
                  if (!window.confirm("纠偏会生成一个新版本，当前版本不会直接被改写。继续吗？")) return {};
                  if (data.mergedVersion == null) return { error: "当前版本信息未能读取，请刷新页面后再试。" };
                  const r = await confirmMerged(data.id, data.mergedVersion, correction);
                  return r.error ? { error: r.error } : {};
                })
              }
            >
              提交纠偏，重新生成
            </Button>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!window.confirm("确认后，这一版共同理解会成为双方可见的共同内容；你的私密原话仍不会分享。继续吗？")) return {};
                  if (data.mergedVersion == null) return { error: "当前版本信息未能读取，请刷新页面后再试。" };
                  const r = await confirmMerged(data.id, data.mergedVersion);
                  return r.error ? { error: r.error } : {};
                })
              }
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
            >
              没有异议，确认这一版
            </button>
          </div>
        </>
      )}
    </StepCard>
  );
}

function MergedCard({ m, role }: { m: MergedUnderstanding; role: string }) {
  const isA = role === "a";
  const suggestions = isA ? m.a_suggestions : m.b_suggestions;
  const partnerView = isA ? m.a_partner_view : m.b_partner_view;
  const repairForA = m.repair_phrases.a.trim();
  const repairForB = m.repair_phrases.b.trim();
  return (
    <div className="space-y-4 rounded-2xl bg-surface p-4 text-sm">
      {m.event_summary && (
        <div>
          <div className="mb-1 text-xs font-medium text-slate-400">事件经过</div>
          <p className="text-slate-700">{m.event_summary}</p>
        </div>
      )}
      <Suggestion title="给你的建议" items={suggestions} />
      {partnerView && (
        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
          <div className="mb-1 text-xs font-medium text-primary">TA 可能的难处</div>
          <p className="text-slate-700">{partnerView}</p>
        </div>
      )}
      <Block title="共同事实" items={m.shared_facts} />
      <div className="grid gap-3">
        <View title="A 的视角" v={m.a_view} />
        <View title="B 的视角" v={m.b_view} />
      </div>
      <Block title="理解不一致的地方" items={m.different_views} />
      <Block title="还没确认的事" items={m.unresolved} />
      {(repairForA || repairForB) && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-400">可以试着这样说</div>
          {repairForA && <p className="text-slate-600">A 可以这样说：{repairForA}</p>}
          {repairForB && <p className="text-slate-600">B 可以这样说：{repairForB}</p>}
        </div>
      )}
      {m.mock && (
        <p className="pt-1 text-xs text-amber-600">（演示数据：尚未接入 DeepSeek，内容为占位）</p>
      )}
    </div>
  );
}

function Suggestion({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
      <div className="mb-1 text-xs font-medium text-primary">{title}</div>
      <ul className="space-y-1 text-slate-700">
        {items.map((x, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-primary">·</span>
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Block({ title, items }: { title: string; items?: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-400">{title}</div>
      {items && items.length > 0 ? (
        <ul className="space-y-1 text-slate-700">
          {items.map((x, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-slate-300">·</span>
            <span>{x}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-400">无</p>
      )}
    </div>
  );
}

function View({
  title,
  v,
}: {
  title: string;
  v: { feelings: string[]; needs: string[]; request: string };
}) {
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
      <div className="mb-1 text-xs font-medium text-primary">{title}</div>
      <div className="text-slate-600">
        感受：{(v.feelings ?? []).join("、") || "—"}
        <br />
        需要：{(v.needs ?? []).join("、") || "—"}
        <br />
        希望：{v.request || "—"}
      </div>
    </div>
  );
}

function AgreementStep({
  data,
  custom,
  setCustom,
  busy,
  run,
}: {
  data: EventData;
  custom: string;
  setCustom: (v: string) => void;
  busy: boolean;
  run: (fn: () => Promise<{ error?: string }>) => void;
}) {
  const mine = data.role === "a" ? data.choices.a : data.choices.b;
  const other = data.role === "a" ? data.choices.b : data.choices.a;
  const options = data.role === "a" ? (data.merged?.a_actions ?? []) : (data.merged?.b_actions ?? []);
  return (
    <StepCard
      title="选择你的行动方针"
      hint="这是你愿意为这段关系做的一小步。对方也会选 TA 自己的，你们各自改进、各自不同，这是正常的。"
    >
      {mine ? (
        <div className="space-y-1">
          <p className="text-sm text-emerald-600">你已选择：{mine}（可以改选）</p>
          {other ? (
            <p className="text-sm text-slate-500">对方已选择：{other}</p>
          ) : (
            <p className="text-sm text-slate-500">等对方选择 TA 的行动方针…</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">从下面选一个你愿意做的，或写一个自己的。</p>
      )}
      <div className="space-y-2">
        {options.map((opt, i) => (
          <button
            key={i}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await chooseAgreement(data.id, opt);
                return r.error ? { error: r.error } : {};
              })
            }
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-700 transition hover:border-primary hover:bg-surface disabled:opacity-60"
          >
            {opt}
          </button>
        ))}
        <div className="flex gap-2 pt-1">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="或写一个自己的行动"
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          <button
            disabled={busy || !custom.trim()}
            onClick={() =>
              run(async () => {
                const r = await chooseAgreement(data.id, custom.trim());
                return r.error ? { error: r.error } : {};
              })
            }
            className="rounded-xl bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-60"
          >
            用这个
          </button>
        </div>
      </div>
    </StepCard>
  );
}

function DoneStep({
  data,
  busy,
  run,
}: {
  data: EventData;
  busy: boolean;
  run: (fn: () => Promise<{ error?: string }>) => void;
}) {
  const mine = data.role === "a" ? data.aReview : data.bReview;
  const [executed, setExecuted] = useState("");
  const [effect, setEffect] = useState("");
  const [next, setNext] = useState("");

  const pill = (selected: boolean) =>
    `rounded-full border px-3 py-1.5 text-sm transition ${
      selected
        ? "border-primary bg-primary-soft text-primary"
        : "border-slate-200 bg-white text-slate-600 hover:border-primary"
    }`;

  return (
    <StepCard title="你们各自确认了行动方针">
      <div className="space-y-2 rounded-2xl bg-surface p-4 text-sm">
        <div className="text-slate-600">A 的承诺：{data.choices.a || "—"}</div>
        <div className="text-slate-600">B 的承诺：{data.choices.b || "—"}</div>
        {data.dueAt && (
          <div className="pt-1 text-xs text-slate-400">
            约定复访时间：{new Date(data.dueAt).toLocaleDateString()}
          </div>
        )}
      </div>

      {mine ? (
        <p className="text-sm text-emerald-600">
          你已提交复访。等对方也提交后，你们就能看到彼此的反馈。
        </p>
      ) : !data.reviewAvailable ? (
        <p className="rounded-xl bg-primary-soft px-4 py-3 text-sm text-primary">
          复访将在约定日期开放。到时刷新页面即可填写。
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">到期复盘：说说这次约定执行得怎么样。</p>
          <div>
            <div className="mb-2 text-xs font-medium text-primary">约定执行得怎么样？</div>
            <div className="flex flex-wrap gap-2">
              {["做到了", "做到了一部分", "没做到"].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setExecuted(opt)}
                  className={pill(executed === opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-primary">这次调整对你们有帮助吗？</div>
            <textarea
              value={effect}
              onChange={(e) => setEffect(e.target.value)}
              placeholder="（可选）说说你的感受"
              rows={2}
              className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-primary">接下来想怎么走？</div>
            <div className="flex flex-wrap gap-2">
              {["继续", "修改", "停止"].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setNext(opt)}
                  className={pill(next === opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
          <Button
            disabled={busy || !executed || !next}
            onClick={() =>
              run(async () => {
                if (!window.confirm("提交后，对方只会在自己也提交复访后看到这份内容。继续吗？")) return {};
                const r = await submitReview(data.id, { executed, effect, next });
                return r.error ? { error: r.error } : {};
              })
            }
          >
            提交复访
          </Button>
        </div>
      )}
    </StepCard>
  );
}

function ReviewBox({ label, r }: { label: string; r: Review | null }) {
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
      <div className="mb-1 text-xs font-medium text-primary">{label}</div>
      {r ? (
        <div className="space-y-1 break-words text-sm text-slate-700">
          <p>执行：{r.executed}</p>
          {r.effect && <p>感受：{r.effect}</p>}
          <p>下一步：{r.next}</p>
        </div>
      ) : (
        <p className="text-sm text-slate-400">未提交</p>
      )}
    </div>
  );
}

function CompletedStep({ data }: { data: EventData }) {
  return (
    <StepCard title="复访完成">
      {data.merged && <MergedCard m={data.merged} role={data.role} />}
      <div className="space-y-2 rounded-2xl bg-surface p-4 text-sm">
        <div className="text-xs font-medium text-slate-400">这次确认的行动</div>
        <div className="text-slate-600">A：{data.choices.a || "—"}</div>
        <div className="text-slate-600">B：{data.choices.b || "—"}</div>
      </div>
      <div className="space-y-3">
        <ReviewBox label="A 的复盘" r={data.aReview} />
        <ReviewBox label="B 的复盘" r={data.bReview} />
      </div>
      <p className="text-sm text-slate-500">这一次复盘到这里。新的分歧可以随时再发起。</p>
    </StepCard>
  );
}

function GuestJoin({
  code,
  setCode,
  busy,
  onJoin,
}: {
  code: string;
  setCode: (v: string) => void;
  busy: boolean;
  onJoin: () => void;
}) {
  return (
    <StepCard title="加入这次复盘" hint="输入对方给你的 4 位邀请码。">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCD"
          maxLength={4}
          className="w-32 rounded-xl border border-slate-200 px-3 py-2.5 text-center text-sm font-semibold uppercase tracking-widest outline-none focus:border-primary"
        />
        <Button onClick={onJoin} disabled={busy || code.length !== 4}>
          加入
        </Button>
      </div>
    </StepCard>
  );
}

function SafetyExit({ risk }: { risk: string }) {
  if (risk === "private_safety") {
    return (
      <StepCard title="这次双人复盘已暂停">
        <p className="text-sm leading-relaxed text-slate-600">
          这次复盘已停止普通流程。具体内容仍各自私密，你可以回到自己的潜谈，继续获得私密支持。
        </p>
        <Link
          href="/app"
          style={{ color: "#fff" }}
          className="block w-full rounded-xl bg-primary px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-primary-hover"
        >
          回到我的潜谈
        </Link>
      </StepCard>
    );
  }
  const guidance = risk === "self_harm"
    ? "你提到的内容可能涉及自伤或轻生风险。请先不要独自承受，尽快联系一位可信赖的人陪在身边，并把可能伤害自己的物品移远。"
    : risk === "harm_others"
      ? "你提到的内容可能涉及伤害他人的风险。请先与对方拉开安全距离，避免继续争执或接触可能造成伤害的物品，并联系可信赖的人协助。"
      : risk === "mental_health"
        ? "你描述的情况可能涉及持续、严重的精神心理困扰。这里不适合继续按普通伴侣矛盾处理，建议尽快联系精神科、心理治疗师或其他合格专业人员评估。"
        : "你写下的内容可能涉及家暴、胁迫、跟踪或其他人身安全风险。这里不会推动你与对方当面对质，也不会要求你立即作出关系决定。";
  return (
    <StepCard title="我们先停一下">
      <p className="text-sm leading-relaxed text-slate-600">
        {guidance}
      </p>
      <p className="text-sm leading-relaxed text-slate-600">
        如果可以，请先确认自己现在是否安全。你不需要在这里继续讲，也不需要马上作出关系决定。
      </p>
      <div className="rounded-2xl bg-[#fff7ed] p-4 text-sm text-amber-800">
        如果危险正在发生，请优先离开危险现场，使用对方无法查看的设备联系可信赖的人，或拨打当地紧急求助电话（中国大陆 110 / 120）。
      </div>
      <p className="text-sm text-slate-500">你的内容不会被分享给任何人。</p>
      <p className="text-xs leading-5 text-slate-400">
        DeepWe提供关系沟通与情绪整理建议，不提供心理诊断、治疗或法律意见。若涉及人身安全、自伤或伤人风险，或持续、严重的精神心理困扰，建议尽快向相应专业人员寻求帮助。
      </p>
    </StepCard>
  );
}

function Declined() {
  return (
    <StepCard title="对方暂时不想参与">
      <p className="text-sm leading-relaxed text-slate-600">
        没关系，这不代表 TA 不想改善关系。可以换个时间、换种方式再试，或者先照顾好自己。
      </p>
    </StepCard>
  );
}

function InviteActivationStatus({
  status,
}: {
  status: NonNullable<EventData["inviteStatus"]>;
}) {
  const content = {
    waiting: {
      label: "等待激活",
      note: "对方还没有使用这枚邀请码。",
      className: "border-amber-200 bg-amber-50 text-amber-800",
    },
    activated: {
      label: "已激活",
      note: "对方已经加入，正在自己的私密空间里完成潜谈。",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    },
    withdrawn: {
      label: "已撤回",
      note: "旧邀请码已经失效。",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    },
    expired: {
      label: "已过期",
      note: "这枚邀请码已经失效，可以直接生成新码。",
      className: "border-rose-200 bg-rose-50 text-rose-700",
    },
  }[status];

  return (
    <div className={`mb-4 rounded-2xl border px-4 py-3 ${content.className}`}>
      <div className="text-sm font-semibold">邀请码状态：{content.label}</div>
      <div className="mt-1 text-xs leading-relaxed opacity-80">{content.note}</div>
    </div>
  );
}

function Cancelled({
  role,
  busy,
  onContinue,
  onResubmit,
}: {
  role: EventData["role"];
  busy: boolean;
  onContinue: () => void;
  onResubmit: () => void;
}) {
  if (role !== "a") {
    return (
      <StepCard title="这次邀请已撤回">
        <p className="text-sm leading-relaxed text-slate-600">
          发起者已经撤回这次邀请，因此原邀请码不再有效。
        </p>
      </StepCard>
    );
  }

  return (
    <StepCard title="你已撤回邀请">
      <p className="text-sm leading-relaxed text-slate-600">
        撤回的只是刚才那次邀请，你之前的私密对话仍然保留。接下来怎么走，由你决定。
      </p>
      <div className="space-y-3">
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          继续聊一聊
        </button>
        <p className="px-1 text-xs leading-relaxed text-slate-500">
          保留原对话，撤销旧摘要确认；补充完整后再由你决定是否提交。
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onResubmit}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          不修改，重新提交邀请
        </button>
        <p className="px-1 text-xs leading-relaxed text-slate-500">
          沿用已经确认的表达，并生成全新邀请码；被撤回的旧邀请码不会恢复。
        </p>
      </div>
      <Link
        href="/#deepwe-start"
        className="block w-full py-1 text-center text-xs text-slate-400 transition hover:text-slate-600"
      >
        从头发起一次新的复盘
      </Link>
    </StepCard>
  );
}

function Closed() {
  return (
    <StepCard title="这次潜谈已经结束">
      <p className="text-sm leading-relaxed text-slate-600">
        结束时间由你决定。这次没有生成报告或共享内容，也不会自动邀请对方。
      </p>
      <p className="text-sm text-slate-500">以后想再聊时，可以从首页重新开始一次潜谈。</p>
    </StepCard>
  );
}

function OutcomeFeedback({ eventId, onDone }: { eventId: string; onDone: () => void }) {
  const [result, setResult] = useState<"lighter" | "same" | "worse" | "unclear" | "skipped" | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const resultOptions = [
    ["lighter", "轻松了一点"],
    ["same", "差不多"],
    ["worse", "更难受了"],
    ["unclear", "现在说不清"],
  ] as const;
  const reasonOptions = ["没有被理解", "问题太多", "建议没帮助", "等待太久", "暂时不想继续"];
  const needsReason = result === "same" || result === "worse";

  async function submit(nextResult = result) {
    if (!nextResult) return;
    setSubmitting(true);
    await trackAnalytics({
      name: "core_outcome_submitted",
      eventId,
      screen: "event",
      step: "closed",
      result: nextResult,
      ...((nextResult === "same" || nextResult === "worse") && reason ? { reason } : {}),
    });
    setSubmitting(false);
    onDone();
  }

  return (
    <section className="mb-4 rounded-[20px] bg-sky-50 p-5 ring-1 ring-sky-100" aria-labelledby="outcome-feedback-title">
      <h2 id="outcome-feedback-title" className="text-base font-semibold text-slate-900">
        和刚开始相比，现在感觉如何？
      </h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">没有标准答案，也可以跳过。</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {resultOptions.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setResult(value);
              if (value !== "same" && value !== "worse") setReason("");
            }}
            aria-pressed={result === value}
            className={`rounded-xl px-3 py-2.5 text-sm font-medium transition ${
              result === value
                ? "bg-primary text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-sky-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {needsReason && (
        <div className="mt-4">
          <p className="text-xs font-medium text-slate-600">如果愿意，哪一点最影响你？</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {reasonOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setReason(reason === option ? "" : option)}
                aria-pressed={reason === option}
                className={`rounded-full px-3 py-1.5 text-xs transition ${
                  reason === option
                    ? "bg-primary text-white"
                    : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-sky-300"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => submit("skipped")}
          disabled={submitting}
          className="flex-1 rounded-xl bg-white py-2.5 text-sm text-slate-500 ring-1 ring-slate-200 disabled:opacity-50"
        >
          跳过
        </button>
        <button
          type="button"
          onClick={() => submit()}
          disabled={submitting || !result}
          className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          提交
        </button>
      </div>
    </section>
  );
}

function GuideStep({
  role,
  eventId,
  messages,
  busy,
  locked,
  actionBusy,
  canPrepareExpression,
  readyToWrap,
  onSend,
  onEdit,
  canStop,
  onStop,
  onDelete,
  onRegenerate,
  onEnd,
  onFinish,
  onDecline,
}: {
  role: "a" | "b";
  eventId: string;
  messages: { id: number; role: string; content: string; createdAt: number }[];
  busy: boolean;
  locked: boolean;
  actionBusy: boolean;
  canPrepareExpression: boolean;
  readyToWrap: boolean;
  onSend: (msg: string) => Promise<{ error?: string }>;
  onEdit: (messageId: number, msg: string) => Promise<{ error?: string }>;
  canStop: boolean;
  onStop: () => Promise<{ error?: string }>;
  onDelete: (messageId: number) => Promise<{ error?: string }>;
  onRegenerate: (messageId: number, reason: string) => Promise<{ error?: string }>;
  onEnd: () => Promise<{ error?: string }>;
  onFinish: () => Promise<{ error?: string }>;
  onDecline?: () => void;
}) {
  const [input, setInput] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [showEndChoices, setShowEndChoices] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [messageActionBusy, setMessageActionBusy] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [feedbackForId, setFeedbackForId] = useState<number | null>(null);
  const [sendError, setSendError] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);
  const [showPrivacyReminder, setShowPrivacyReminder] = useState(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (shouldAutoScrollRef.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pendingMessage, busy]);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowPrivacyReminder(false), 3200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    const maxHeight = 192;
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    let active = true;
    void getCurrentAccount().then((account) => {
      if (!active) return;
      const key = account.user?.id && !account.error
        ? `deepwe-draft-v2-${account.user.id}-${eventId}-${role}` : null;
      let restored = "";
      // Legacy keys have no reliable owner. Preserve them without exposing or migrating them.
      try { if (key) restored = window.localStorage.getItem(key) ?? ""; } catch {}
      setInput(restored);
      setDraftKey(key);
      setDraftReady(true);
    });
    return () => { active = false; };
  }, [eventId, role]);

  useEffect(() => {
    if (!draftReady || !draftKey) return;
    try {
      if (input) window.localStorage.setItem(draftKey, input);
      else window.localStorage.removeItem(draftKey);
    } catch { /* Storage may be unavailable; the current draft remains usable in memory. */ }
  }, [draftReady, draftKey, input]);

  function sendMessage(msg: string) {
    const clean = msg.trim();
    if (!clean || locked || pendingMessage) return;
    setPendingMessage(msg);
    shouldAutoScrollRef.current = true;
    setSendError("");
    void onSend(clean).then((result) => {
      if (result.error) {
        setInput((current) => current || clean);
        setSendError(result.error);
      }
      setPendingMessage(null);
    });
  }

  function submit() {
    if (!input.trim()) return;
    const msg = input.trim();
    setInput("");
    sendMessage(msg);
  }

  function beginEdit(messageId: number, content: string) {
    setSelectedMessageId(messageId);
    setEditingId(messageId);
    setEditingText(content);
  }

  async function saveEdit() {
    if (editingId === null || !editingText.trim()) return;
    setEditBusy(true);
    const result = await onEdit(editingId, editingText.trim());
    setEditBusy(false);
    if (!result.error) {
      setEditingId(null);
      setEditingText("");
      setSelectedMessageId(null);
      flashNotice("消息已修改，正在重新回答");
    }
  }

  async function removeMessage(messageId: number, isLast: boolean) {
    const confirmed = window.confirm(
      isLast
        ? "撤销这条消息？AI 对它的回复也会一起移除。"
        : "删除这条消息？这条消息之后的对话也会移除，避免 AI 继续使用已经删除的内容。"
    );
    if (!confirmed) return;
    setMessageActionBusy(true);
    const result = await onDelete(messageId);
    setMessageActionBusy(false);
    if (!result.error) {
      setSelectedMessageId(null);
      flashNotice(isLast ? "消息已撤销" : "消息已删除");
    }
  }

  async function regenerate(messageId: number, reason: string) {
    setMessageActionBusy(true);
    const result = await onRegenerate(messageId, reason);
    setMessageActionBusy(false);
    if (!result.error) {
      setFeedbackForId(null);
      setSelectedMessageId(null);
      flashNotice("正在换一种方式回答");
    }
  }

  async function copyMessage(messageId: number, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId(null), 1600);
    } catch {
      setSendError("复制失败，请稍后重试");
    }
  }

  function flashNotice(message: string) {
    setActionNotice(message);
    window.setTimeout(() => setActionNotice(""), 2200);
  }

  async function stopReply() {
    const result = await onStop();
    if (!result.error) flashNotice("已停止生成");
  }

  function startLongPress(messageId: number) {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      setSelectedMessageId(messageId);
      if (navigator.vibrate) navigator.vibrate(20);
    }, 450);
  }

  function cancelLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function onMessageScroll() {
    const element = messageAreaRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    shouldAutoScrollRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }

  const lastUserMessageId = [...messages].reverse().find((message) => message.role !== "ai")?.id;
  const latestAiMessageId = messages.at(-1)?.role === "ai" ? messages.at(-1)!.id : null;

  function previousUserMessageId(index: number): number | null {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role !== "ai") return messages[cursor].id;
    }
    return null;
  }

  return (
    <div className="relative flex h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-[20px] bg-white ring-1 ring-slate-200">
      {showPrivacyReminder && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-20 w-max max-w-[calc(100%_-_2rem)] -translate-x-1/2 rounded-full bg-slate-800/90 px-4 py-2 text-center text-xs leading-5 text-white shadow-lg backdrop-blur"
        >
          这里只有你能看到；DeepWe 只记沟通偏好，不把争吵经过作为长期记忆
        </div>
      )}
      {actionNotice && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-slate-800/90 px-4 py-2 text-xs text-white shadow-lg">
          {actionNotice}
        </div>
      )}
      {/* 只在第一次开始潜谈时说明；进入持续对话后自动收起，给消息区留出空间。 */}
      {messages.length <= 2 && (
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="text-sm font-semibold text-slate-900">潜谈 2.0</div>
          <div className="mt-1 text-xs text-slate-400">这里不赶着得出结论，也不会替你决定什么时候结束</div>
          <div className="mt-1 text-[11px] text-slate-400">这是复盘整理工具，不是心理诊断或治疗</div>
        </div>
      )}

      {/* 消息区 */}
      <div
        ref={messageAreaRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        onScroll={onMessageScroll}
        onClick={() => {
          setSelectedMessageId(null);
          setFeedbackForId(null);
        }}
      >
        {messages.map((m, index) =>
          editingId === m.id ? (
            <div key={m.id} className="flex justify-end">
              <div className="w-[90%] rounded-2xl border border-sky-200 bg-sky-50 p-3">
                <textarea
                  value={editingText}
                  onChange={(e) => setEditingText(e.target.value)}
                  rows={4}
                  autoFocus
                  aria-label="修改聊天内容"
                  className="max-h-48 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    disabled={editBusy}
                    className="rounded-full px-3 py-1.5 text-xs text-slate-500 disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={editBusy || !editingText.trim()}
                    className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {editBusy ? "重新理解中…" : "保存并重新回答"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              key={m.id}
              className={m.role !== "ai" ? "flex justify-end" : "flex justify-start"}
              onClick={(event) => {
                event.stopPropagation();
                setSelectedMessageId(m.id);
              }}
              onPointerDown={() => startLongPress(m.id)}
              onPointerUp={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onPointerLeave={cancelLongPress}
            >
              <div className={m.role !== "ai" ? "group max-w-[80%] text-right" : "group max-w-[80%]"}>
                <div
                  className={
                    m.role !== "ai"
                      ? "whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-left text-sm text-white"
                      : "whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-700"
                  }
                >
                  {m.content}
                </div>
                {m.role !== "ai" && m.id === lastUserMessageId && (
                  <div
                    className={`mt-1 items-center justify-end gap-1 px-1 ${
                      selectedMessageId === m.id
                        ? "flex"
                        : "hidden group-hover:flex group-focus-within:flex"
                    }`}
                  >
                    <span className="mr-1 text-[10px] text-slate-300" title={fullMessageTimestamp(m.createdAt)}>
                      {formatMessageTimestamp(m.createdAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyMessage(m.id, m.content)}
                      className="rounded-md px-1.5 py-0.5 text-sm text-slate-400 hover:bg-slate-100 hover:text-primary"
                      aria-label="复制消息"
                      title="复制"
                    >
                      {copiedMessageId === m.id ? "✓" : "⧉"}
                    </button>
                    <button
                      type="button"
                      onClick={() => beginEdit(m.id, m.content)}
                      disabled={locked || editBusy || messageActionBusy}
                      className="rounded-md px-1.5 py-0.5 text-sm text-slate-400 hover:bg-slate-100 hover:text-primary disabled:opacity-40"
                      aria-label="修改消息"
                      title="修改"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => removeMessage(m.id, m.id === lastUserMessageId)}
                      disabled={locked || editBusy || messageActionBusy}
                      className="rounded-md px-1.5 py-0.5 text-sm text-muted hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                      aria-label={m.id === lastUserMessageId ? "撤销消息" : "删除消息"}
                      title={m.id === lastUserMessageId ? "撤销" : "删除"}
                    >
                      {m.id === lastUserMessageId ? "↶" : "⌫"}
                    </button>
                  </div>
                )}
                {m.role === "ai" && m.id === latestAiMessageId && previousUserMessageId(index) === lastUserMessageId && (
                  <div
                    className={`mt-1 px-1 ${
                      selectedMessageId === m.id || feedbackForId === m.id
                        ? "block"
                        : "hidden group-hover:block group-focus-within:block"
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="mr-1 text-[10px] text-slate-300" title={fullMessageTimestamp(m.createdAt)}>
                        {formatMessageTimestamp(m.createdAt)}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyMessage(m.id, m.content)}
                        className="rounded-md px-1.5 py-0.5 text-sm text-slate-400 hover:bg-slate-100 hover:text-primary"
                        aria-label="复制消息"
                        title="复制"
                      >
                        {copiedMessageId === m.id ? "✓" : "⧉"}
                      </button>
                    <button
                      type="button"
                      onClick={() => setFeedbackForId(feedbackForId === m.id ? null : m.id)}
                      disabled={locked || messageActionBusy}
                      className="rounded-md px-1.5 py-0.5 text-sm text-slate-400 hover:bg-slate-100 hover:text-primary disabled:opacity-40"
                      aria-label="AI 没有理解我"
                      title="没理解我"
                    >
                      ↻
                    </button>
                    </div>
                    {feedbackForId === m.id && (
                      <div className="mt-2 grid gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
                        {["理解错了", "问得太机械", "我不想回答这个", "换个方式问"].map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            onClick={() => regenerate(previousUserMessageId(index)!, reason)}
                            className="rounded-lg px-2 py-1.5 text-left text-xs text-primary hover:bg-sky-50 hover:text-primary"
                          >
                            {reason}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {pendingMessage && (
          <div className="flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-white">
              {pendingMessage}
            </div>
          </div>
        )}
        {(busy || pendingMessage) && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-400">
              <div>正在理解你刚才的话…</div>
              {canStop && (
                <button
                  type="button"
                  onClick={stopReply}
                  className="mt-1.5 text-xs text-slate-500 underline underline-offset-2 hover:text-primary"
                >
                  停止生成
                </button>
              )}
            </div>
          </div>
        )}
        <div ref={endRef} />
        {showJumpToLatest && (
          <div className="sticky bottom-2 flex justify-center">
            <button
              type="button"
              onClick={() => {
                shouldAutoScrollRef.current = true;
                endRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 shadow-md hover:text-primary"
            >
              回到最新消息 ↓
            </button>
          </div>
        )}
      </div>

      {/* 底部输入区 */}
      <div className="border-t border-slate-100 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            disabled={!draftReady || locked || !!pendingMessage}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            aria-label="聊天内容"
            placeholder="想说什么都可以继续；不想展开的部分可以说“跳过”…"
            className="min-h-12 flex-1 resize-y rounded-xl border border-slate-200 px-3 py-2.5 text-sm leading-6 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:bg-slate-50"
          />
          <div className="flex shrink-0 flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => setShowEndChoices((current) => !current)}
              disabled={actionBusy}
              aria-label="更多操作"
              aria-expanded={showEndChoices}
              title="更多操作"
              className={`relative flex h-6 w-6 items-center justify-center rounded-full border text-sm leading-none transition disabled:opacity-50 ${
                showEndChoices || readyToWrap
                  ? "border-primary/20 bg-primary-soft text-primary"
                  : "border-slate-200 bg-white text-slate-400 hover:text-slate-600"
              }`}
            >
              ⋯
              {readyToWrap && !showEndChoices && (
                <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
              )}
            </button>
            <button
              onClick={submit}
              disabled={locked || !!pendingMessage || !input.trim()}
              className="h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-60"
            >
              发送
            </button>
          </div>
        </div>
        {sendError && (
          <div className="mt-2 flex items-center justify-between rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <span>{sendError}，原文已经保留。</span>
            <button type="button" onClick={submit} disabled={!input.trim()} className="ml-2 font-medium underline">
              重试
            </button>
          </div>
        )}
        {showEndChoices ? (
          <div className="mt-3 space-y-2 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-700">更多操作</p>
            <p className="text-xs leading-relaxed text-slate-500">
              什么时候结束仍然由你决定；也可以继续留在这里慢慢聊。
            </p>
            <button
              type="button"
              onClick={() => setShowEndChoices(false)}
              disabled={actionBusy}
              className="w-full rounded-xl bg-white py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 disabled:opacity-60"
            >
              我还想继续聊
            </button>
            <button
              type="button"
              onClick={onEnd}
              disabled={actionBusy}
              className="w-full rounded-xl bg-white py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 disabled:opacity-60"
            >
              只结束，不生成任何内容
            </button>
            <button
              type="button"
              onClick={onFinish}
              disabled={actionBusy || !canPrepareExpression}
              className="w-full rounded-xl bg-primary py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              结束，并整理一份我可以修改的表达
            </button>
            {!canPrepareExpression && (
              <p className="text-center text-[11px] text-slate-400">
                当前回复完成后可以整理；你仍然可以现在直接结束
              </p>
            )}
            {onDecline && (
              <button
                type="button"
                onClick={onDecline}
                disabled={locked}
                className="w-full rounded-xl py-2 text-sm text-slate-500 hover:bg-white disabled:opacity-60"
              >
                暂时不想参与，拒绝这次复盘
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
