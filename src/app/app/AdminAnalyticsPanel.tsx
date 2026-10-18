"use client";

import { useEffect, useState } from "react";
import { getAdminAnalytics } from "@/lib/api";
import type { AdminAnalyticsDashboard, AnalyticsBreakdownPoint, AnalyticsFunnelPoint } from "@/lib/types";

const EVENT_LABELS: Record<string, string> = {
  app_opened: "进入应用", event_created: "发起复盘", guide_started: "开始表达",
  summary_requested: "整理表达", summary_confirmed: "确认摘要", guide_ended: "主动结束",
  registration_completed: "完成注册", login_completed: "完成登录", screen_viewed: "查看页面",
  screen_left: "离开页面", guide_stage_viewed: "查看潜谈步骤",
  partner_invite_created: "创建伴侣邀请", partner_event_invite_later: "稍后处理复盘邀请",
  partner_invite_accepted: "接受伴侣绑定", partner_event_invite_accepted: "接受复盘邀请",
  shared_understanding_confirmed: "确认共同理解", agreement_submitted: "确认各自行动", review_submitted: "完成回望",
  conversation_created: "开始私密对话", private_message_sent: "发送本人消息", private_reply_completed: "收到回复",
  conversation_message_sent: "发送本人消息", conversation_share_prepared: "整理分享草稿",
  conversation_share_confirmed: "确认分享版本", conversation_deleted: "删除私密对话",
  message_feedback_submitted: "提交回复反馈", core_outcome_submitted: "提交结束感受",
  ai_stopped: "暂停 AI 回复", ai_retried: "重试 AI 回复",
  request_failed: "请求失败",
};
const OUTCOME_LABELS: Record<string, string> = { lighter: "轻松了一点", same: "差不多", worse: "更难受了", unclear: "现在说不清", skipped: "跳过" };
const FEEDBACK_REASON_LABELS: Record<string, string> = {
  "理解错了": "理解错了",
  "问得太机械": "问得太机械",
  "我不想回答这个": "我不想回答这个",
  "换个方式问": "换个方式问",
  "没有被理解": "没有被理解",
  "问题太多": "问题太多",
  "建议没帮助": "建议没帮助",
  "等待太久": "等待太久",
  "暂时不想继续": "暂时不想继续",
};
const STEP_LABELS: Record<string, string> = {
  home: "私密对话首页", conversation: "私密聊天", notes: "对话要点", share_draft: "分享草稿",
  couple: "双人空间", records: "复盘记录", a_guiding: "发起者表达", b_guiding: "伴侣表达", merged: "共同理解", review: "到期回望",
  guide_ended: "结束本次对话", message_feedback_submitted: "回复反馈", core_outcome_submitted: "结束感受反馈",
  auth: "登录与注册", events: "复盘流程", admin: "管理面板", request_failed: "请求失败",
  screen_viewed: "查看页面", screen_left: "离开页面", guide_stage_viewed: "潜谈步骤",
  registration_completed: "完成注册", login_completed: "完成登录", app_opened: "进入应用",
  event_created: "发起复盘", guide_started: "开始表达", summary_requested: "整理表达", summary_confirmed: "确认摘要",
  partner_invite_created: "创建伴侣邀请", partner_invite_accepted: "接受伴侣绑定", partner_event_invite_accepted: "接受复盘邀请",
  partner_event_invite_later: "稍后处理复盘邀请", shared_understanding_confirmed: "确认共同理解",
  agreement_submitted: "确认各自行动", review_submitted: "完成回望", ai_stopped: "暂停 AI 回复", ai_retried: "重试 AI 回复",
  conversation_created: "开始私密对话", conversation_message_sent: "发送本人消息",
  conversation_share_prepared: "整理分享草稿", conversation_share_confirmed: "确认分享版本", conversation_deleted: "删除私密对话",
};
const COUPLE_EVENTS = new Set([
  "event_created", "guide_started", "summary_requested", "summary_confirmed", "partner_invite_created",
  "partner_invite_accepted", "partner_event_invite_accepted", "partner_event_invite_later",
  "shared_understanding_confirmed", "agreement_submitted", "review_submitted",
]);
const JOB_LABELS: Record<string, string> = {
  reply: "对话回复",
  notes: "整理要点",
  share_draft: "整理分享草稿",
  guide: "旧版潜谈",
  summary: "整理表达",
  merge: "共同理解",
  private_reply: "私密对话回复",
  private_notes: "私密笔记整理",
  private_share: "私密分享整理",
};

function Funnel({ title, rows }: { title: string; rows: AnalyticsFunnelPoint[] }) {
  if (!rows.length) return <section className="analyticsBlock"><h3>{title}</h3><p>目前没有达到隐私门槛的可展示结果。</p></section>;
  const max = Math.max(1, ...rows.map((row) => row.users));
  return <section className="analyticsBlock"><h3>{title}</h3><div className="analyticsRows">{rows.map((row) => <div key={row.name}>
    <div className="analyticsLabel"><span>{EVENT_LABELS[row.name] ?? STEP_LABELS[row.name] ?? "其他步骤"}</span><span>{row.users} 人 · {row.count} 次</span></div>
    <div className="analyticsBar"><span style={{ width: `${row.users ? Math.max(5, row.users / max * 100) : 0}%` }} /></div>
  </div>)}</div></section>;
}

function Breakdown({ title, rows, labels = {}, sessions = false }: { title: string; rows: AnalyticsBreakdownPoint[]; labels?: Record<string, string>; sessions?: boolean }) {
  return <section className="analyticsBlock"><h3>{title}</h3>{rows.length ? <ul className="analyticsList">{rows.map((row) => <li key={row.label}><span>{labels[row.label] ?? STEP_LABELS[row.label] ?? "其他步骤"}</span><span>{sessions ? `${row.sessions ?? 0} 段` : `${row.count ?? 0} 次`} · {row.users} 人</span></li>)}</ul> : <p>目前没有达到隐私门槛的可展示结果。</p>}</section>;
}

export default function AdminAnalyticsPanel() {
  const [days, setDays] = useState<7 | 30 | 90>(7);
  const [data, setData] = useState<AdminAnalyticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const coupleFunnel = (data?.funnel ?? []).filter((row) => COUPLE_EVENTS.has(row.name));
  const feedbackReasons = (data?.feedbackReasons ?? []).filter((row) =>
    Object.prototype.hasOwnProperty.call(FEEDBACK_REASON_LABELS, row.label)
  );

  function refresh() {
    setLoading(true);
    setError("");
    setRefreshKey((key) => key + 1);
  }

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await getAdminAnalytics(days);
        if (!active) return;
        if (result.error || !result.analytics) {
          setError(result.status === 403 ? "服务端拒绝了管理员访问。请重新确认账号权限。" : result.error ?? "暂时无法读取聚合数据，请稍后重试。");
          setData(null);
          return;
        }
        setData(result.analytics);
        setError("");
      } catch {
        if (!active) return;
        setError("暂时无法读取聚合数据，请稍后重试。");
        setData(null);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [days, refreshKey]);

  return <section className="analyticsPanel" aria-labelledby="analytics-title">
    <div className="analyticsHeader"><div><h2 id="analytics-title">体验数据</h2><p>仅显示达到隐私门槛的聚合结果，不含聊天内容或个人轨迹。</p></div>
      <div className="analyticsControls" aria-label="统计时间范围">{([7, 30, 90] as const).map((value) => <button key={value} type="button" aria-pressed={days === value} onClick={() => { setLoading(true); setError(""); if (days === value) setRefreshKey((key) => key + 1); else setDays(value); }}>{value} 天</button>)}<button type="button" onClick={refresh}>刷新</button></div>
    </div>
    {loading && <p className="analyticsState" role="status">正在读取聚合结果…</p>}
    {error && <div className="analyticsError" role="alert"><p>{error}</p><button type="button" onClick={refresh}>重试</button></div>}
    {!loading && !error && data && <>
      <div className="analyticsOverview"><div><span>活跃用户</span><strong>{data.overview.activeUsers >= data.privacyThreshold ? data.overview.activeUsers : "样本不足"}</strong></div><div><span>体验会话</span><strong>{data.overview.activeUsers >= data.privacyThreshold ? data.overview.sessions : "样本不足"}</strong></div><div><span>记录事件</span><strong>{data.overview.activeUsers >= data.privacyThreshold ? data.overview.events : "样本不足"}</strong></div></div>
      {data.detailsSuppressed && <p className="analyticsState">当前样本较少，部分细分结果已隐藏。</p>}
      <div className="analyticsGrid"><Funnel title="私密对话路径" rows={data.conversationFunnel.filter((row) => row.name.startsWith("conversation_"))} /><Funnel title="双人复盘路径" rows={coupleFunnel} />
        <Breakdown title="可能的最后停留位置" rows={data.lastSteps} labels={STEP_LABELS} sessions />
        <Breakdown title="用户主动反馈的原因" rows={feedbackReasons} labels={FEEDBACK_REASON_LABELS} />
        <Breakdown title="结束时的感受变化" rows={data.outcomes} labels={OUTCOME_LABELS} />
      </div>
      <section className="analyticsBlock analyticsModel"><h3>模型调用（聚合）</h3>{data.models.length ? <div className="analyticsTableWrap"><table><thead><tr><th>模型 / 任务</th><th>调用</th><th>成功</th><th>失败</th><th>平均耗时</th><th>输入 / 输出 token</th></tr></thead><tbody>{data.models.map((model) => <tr key={`${model.model}-${model.jobKind}`}><td>{model.model} · {JOB_LABELS[model.jobKind] ?? "其他"}</td><td>{model.calls}</td><td>{model.successful}</td><td>{model.failed}</td><td>{model.averageDurationMs ? `${(model.averageDurationMs / 1000).toFixed(1)} 秒` : "—"}</td><td>{model.inputTokens} / {model.outputTokens}</td></tr>)}</tbody></table></div> : <p>暂无达到隐私门槛的模型调用统计。</p>}</section>
      <p className="analyticsFootnote">少于 {data.privacyThreshold} 位用户的细分结果会隐藏；原始体验事件保留 {data.retentionDays} 天。管理员看不到私密对话、分享草稿、单人轨迹或身份信息。</p>
    </>}
  </section>;
}
