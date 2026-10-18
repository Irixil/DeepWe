import * as db from "./db.js";
import {
  AiMergeValidationError,
  AiServiceError,
  AiResultUnknownError,
  emptyStoryMap,
  guideReply,
  merge,
  normalizeStoryMap,
  summarize,
  type StoryMap,
  type NvcSummary,
} from "./ai.js";
import { persistDatabaseIfChanged } from "./persistence.js";

const workerState = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };

function storyFor(eventId: string, side: db.GuideSide): StoryMap {
  const session = db.getGuideSession(eventId, side);
  if (!session?.story_map) return emptyStoryMap();
  try {
    return normalizeStoryMap(JSON.parse(session.story_map)) ?? emptyStoryMap();
  } catch {
    return emptyStoryMap();
  }
}

function userIdFor(eventId: string, side: db.GuideSide): string | null {
  const event = db.getEvent(eventId);
  if (!event) return null;
  return side === "a" ? event.a_user_id : event.b_user_id;
}

async function processGuideJob(job: db.AiJobRow): Promise<void> {
  if (!job.side || !job.user_message_id) throw new Error("guide job input missing");
  const message = db.getGuideMessageById(job.user_message_id);
  if (!message) throw new Error("guide message missing");
  const session = db.getGuideSession(job.event_id, job.side);
  const userId = userIdFor(job.event_id, job.side);
  const turn = await guideReply(
    db.getGuideMessagesBefore(job.event_id, job.side, job.user_message_id),
    message.content,
    storyFor(job.event_id, job.side),
    session?.stage,
    userId ? db.describePersonalPreferences(userId) : []
  );
  db.completeGuideAiJob(
    job,
    turn.reply,
    turn.stage,
    JSON.stringify(turn.storyMap),
    userId,
    turn.preferenceSignals
  );
}

async function processSummaryJob(job: db.AiJobRow): Promise<void> {
  if (!job.side) throw new Error("summary job side missing");
  const story = storyFor(job.event_id, job.side);
  const perspective = db.getPerspective(job.event_id, job.side);
  const summary = await summarize(
    `用户主动结束了本次潜谈，并选择整理一份可修改的表达。只根据用户亲自说过的内容和后台故事地图整理，不补充未出现的信息。\n\n用户原始表达：\n${perspective?.raw_text ?? ""}\n\n后台故事地图：\n${JSON.stringify(story, null, 2)}`
  );
  db.completeSummaryAiJob(
    job,
    JSON.stringify(summary),
    job.side === "a" ? "a_guiding" : "b_guiding"
  );
}

async function processMergeJob(job: db.AiJobRow): Promise<void> {
  const a = db.getPerspective(job.event_id, "a");
  const b = db.getPerspective(job.event_id, "b");
  if (!a?.summary || !b?.summary || a.summary_confirmed !== 1 || b.summary_confirmed !== 1 || !db.mergeJobInputsStillCurrent(job)) {
    throw new Error("confirmed summaries missing");
  }
  const previousRow = job.kind === "merge_correction" ? db.getMerged(job.event_id) : null;
  if (job.kind === "merge_correction" && !previousRow?.content) {
    throw new AiMergeValidationError("MERGE_PREVIOUS_VIEW_MISSING");
  }
  const previous = previousRow?.content ? JSON.parse(previousRow.content) as Awaited<ReturnType<typeof merge>> : null;
  const merged = await merge(
    JSON.parse(a.summary) as NvcSummary,
    JSON.parse(b.summary) as NvcSummary,
    job.kind === "merge_correction" ? a.correction : null,
    job.kind === "merge_correction" ? b.correction : null,
    job.event_id,
    {jobId:job.id},
    previous
  );
  db.completeMergeAiJob(job, JSON.stringify(merged));
}

async function processAiJob(job: db.AiJobRow): Promise<void> {
  try {
    if (!db.aiJobInputsAreAllowed(job)) { db.cancelAiJob(job.id); return; }
    if (job.kind === "guide") await processGuideJob(job);
    else if (job.kind === "summary") await processSummaryJob(job);
    else await processMergeJob(job);
  } catch (error) {
    const message =
      error instanceof AiServiceError
        ? error.message
        : "后台理解任务暂时失败，请重试";
    console.error("AI background job failed", {
      jobId: job.id,
      kind: job.kind,
      reason: error instanceof Error ? error.name : "unknown",
    });
    db.failAiJob(job.id, message, error instanceof AiMergeValidationError ? error.errorCode : error instanceof AiResultUnknownError ? "AI_RESULT_UNKNOWN" : null, job.attempts);
  } finally {
    try {
      await persistDatabaseIfChanged();
    } catch {
      // 定时同步会继续重试；不要因为一次存储故障中断后续 AI 任务。
      console.error("AI result snapshot failed; retrying automatically");
    }
  }
}

export function wakeAiWorker(): void {
  if (workerState.__deepweAiWorkerRunning) return;
  workerState.__deepweAiWorkerRunning = true;
  queueMicrotask(async () => {
    try {
      let job = db.claimNextAiJob();
      while (job) {
        await processAiJob(job);
        job = db.claimNextAiJob();
      }
    } finally {
      workerState.__deepweAiWorkerRunning = false;
      if (db.hasQueuedAiJob()) wakeAiWorker();
    }
  });
}

export function startAiWorker(): void {
  db.requeueInterruptedAiJobs();
  wakeAiWorker();
}
