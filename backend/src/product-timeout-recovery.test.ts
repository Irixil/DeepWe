import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./ai-worker", () => ({ wakeAiWorker: vi.fn() }));
import api from "./routes";
import * as db from "./db";
import { AiResultUnknownError, AiServiceError, merge, type MergedUnderstanding, type NvcSummary } from "./ai";

const summaryA: NvcSummary = { observation: "A 的已确认摘要", feelings: ["失落"], needs: ["沟通"], request: "提前告知" };
const summaryB: NvcSummary = { observation: "B 的已确认摘要", feelings: ["压力"], needs: ["理解"], request: "先说明情况" };
const existingMerge: MergedUnderstanding = {
  event_summary: "已经保存的共同理解。", shared_facts: ["双方确认了摘要"],
  a_view: { feelings: ["失落"], needs: ["沟通"], request: "提前告知" },
  b_view: { feelings: ["压力"], needs: ["理解"], request: "先说明情况" },
  different_views: [], unresolved: [], repair_phrases: { a: "A", b: "B" },
  a_suggestions: [], a_partner_view: "A 的私有视角", a_actions: [],
  b_suggestions: [], b_partner_view: "B 的私有视角", b_actions: [],
};

function cookie(eventId: string, token: string): string { return `dw_${eventId}=${token}`; }

function mergedFixture() {
  const event = db.createEvent("timeout recovery");
  const bToken = db.randomToken();
  db.setBTokens(event.id, bToken);
  db.upsertPerspective(event.id, "a", "private A source");
  db.upsertPerspective(event.id, "b", "private B source");
  db.setSummary(event.id, "a", JSON.stringify(summaryA));
  db.setSummary(event.id, "b", JSON.stringify(summaryB));
  db.confirmSummary(event.id, "a");
  db.confirmSummary(event.id, "b");
  db.transition(event.id, "a_guiding", "a_summary");
  db.transition(event.id, "a_summary", "waiting_b");
  db.transition(event.id, "waiting_b", "b_guiding");
  db.transition(event.id, "b_guiding", "b_summary");
  db.upsertMerged(event.id, JSON.stringify(existingMerge));
  db.transition(event.id, "b_summary", "merged");
  return { event, bToken };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("bounded product merge recovery", () => {
  it("treats a lost merge response as unknown and sends only one request", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("synthetic connection loss")));

    await expect(merge(summaryA, summaryB)).rejects.toBeInstanceOf(AiResultUnknownError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a truncated response body as unknown and does not send a second request", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    const response = { ok: true, json: vi.fn().mockRejectedValue(new SyntaxError("synthetic truncated body")) } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(merge(summaryA, summaryB)).rejects.toBeInstanceOf(AiResultUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an abort while reading the response body as unknown after one request", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    vi.stubEnv("DEEPWE_FINAL_TIMEOUT_MS", "10");
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise<unknown>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("synthetic body read aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const pending = merge(summaryA, summaryB);
    const outcome = expect(pending).rejects.toBeInstanceOf(AiResultUnknownError);
    await vi.advanceTimersByTimeAsync(10);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists unknown outcome across restart and blocks the retry endpoint for both participants", async () => {
    const { event, bToken } = mergedFixture();
    const job = db.enqueueAiJob(event.id, "merge_correction", "a");
    const claimed = db.claimNextAiJob()!;
    db.failAiJob(claimed.id, "共同理解未完成。双方确认的摘要已保存；上一次请求结果尚不确定，暂不会自动重新生成。你可以刷新查看状态。", "AI_RESULT_UNKNOWN");

    db.requeueInterruptedAiJobs();
    expect(db.getAiJob(job.id)).toMatchObject({ status: "failed", error_code: "AI_RESULT_UNKNOWN", attempts: 1 });
    expect(db.retryVisibleAiJob(event.id, "a")).toBe(false);

    for (const token of [event.aToken, bToken]) {
      const response = await api.request(`/events/${event.id}`, { headers: { Cookie: cookie(event.id, token) } });
      expect(await response.json()).toMatchObject({
        aiJobId: job.id,
        aiJobAttempt: 1,
        aiJobErrorCode: "AI_RESULT_UNKNOWN",
        aiJobRetryAllowed: false,
        aiJobError: expect.stringContaining("上一次请求结果尚不确定"),
      });
      const retry = await api.request(`/events/${event.id}/ai/retry`, { method: "POST", headers: { Cookie: cookie(event.id, token) } });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({ code: "AI_RESULT_UNKNOWN", retryAllowed: false });
    }
    expect((await api.request(`/events/${event.id}`)).status).toBe(404);

    const interruptedFixture = mergedFixture();
    const interrupted = db.enqueueAiJob(interruptedFixture.event.id, "merge_correction", "a");
    db.db.prepare("UPDATE ai_jobs SET status = 'processing', attempts = 1 WHERE id = ?").run(interrupted.id);
    db.requeueInterruptedAiJobs();
    expect(db.getAiJob(interrupted.id)).toMatchObject({ status: "failed", error_code: "AI_RESULT_UNKNOWN", attempts: 1 });
  });

  it("rejects stale attempts and duplicate completions, and cancels changed inputs", () => {
    const { event } = mergedFixture();
    const job = db.enqueueAiJob(event.id, "merge_correction", "a");
    const claimed = db.claimNextAiJob()!;
    db.db.prepare("UPDATE ai_jobs SET attempts = attempts + 1 WHERE id = ?").run(job.id);
    db.failAiJob(job.id, "late attempt failure", "AI_RESULT_UNKNOWN", claimed.attempts);
    expect(db.getAiJob(job.id)).toMatchObject({ status: "processing", attempts: 2, error: null, error_code: null });
    db.completeMergeAiJob(claimed, JSON.stringify({ ...existingMerge, event_summary: "stale" }));
    expect(JSON.parse(db.getMerged(event.id)!.content!).event_summary).toBe(existingMerge.event_summary);

    const current = db.getAiJob(job.id)!;
    db.completeMergeAiJob(current, JSON.stringify({ ...existingMerge, event_summary: "valid completion" }));
    db.completeMergeAiJob(current, JSON.stringify({ ...existingMerge, event_summary: "duplicate completion" }));
    expect(JSON.parse(db.getMerged(event.id)!.content!).event_summary).toBe("valid completion");

    const changed = db.enqueueAiJob(event.id, "merge_correction", "a");
    const changedClaim = db.claimNextAiJob()!;
    db.setSummary(event.id, "a", JSON.stringify({ ...summaryA, observation: "changed source" }));
    db.confirmSummary(event.id, "a");
    db.completeMergeAiJob(changedClaim, JSON.stringify({ ...existingMerge, event_summary: "obsolete source result" }));
    expect(db.getAiJob(changed.id)?.status).toBe("cancelled");
    expect(JSON.parse(db.getMerged(event.id)!.content!).event_summary).toBe("valid completion");
  });

  it("keeps known failures manually retryable", async () => {
    const { event } = mergedFixture();
    const job = db.enqueueAiJob(event.id, "merge_correction", "a");
    const claimed = db.claimNextAiJob()!;
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await merge(summaryA, summaryB).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiServiceError);
    expect(error).not.toBeInstanceOf(AiResultUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.failAiJob(claimed.id, "AI 服务暂时不可用，请稍后重试");
    expect(db.getAiJob(job.id)).toMatchObject({ status: "failed", error_code: null });
    expect(db.retryVisibleAiJob(event.id, "a")).toBe(true);
    expect(db.getAiJob(job.id)).toMatchObject({ status: "queued", error_code: null });
    db.cancelAiJob(job.id); // Leave no queued fixture for the following test to claim.
  });

  it("rejects a repeated retry payload after a later known failure increments the attempt", async () => {
    const { event } = mergedFixture();
    const job = db.enqueueAiJob(event.id, "merge_correction", "a");
    const firstAttempt = db.claimNextAiJob()!;
    db.failAiJob(firstAttempt.id, "known failure", null, firstAttempt.attempts);
    const headers = { Cookie: cookie(event.id, event.aToken), "Content-Type": "application/json" };
    const retryBody = JSON.stringify({ expectedJobId: job.id, expectedAttempt: firstAttempt.attempts });

    const firstRetry = await api.request(`/events/${event.id}/ai/retry`, { method: "POST", headers, body: retryBody });
    expect(firstRetry.status).toBe(202);
    expect(db.getAiJob(job.id)).toMatchObject({ status: "queued", attempts: 1 });

    const secondAttempt = db.claimNextAiJob()!;
    expect(secondAttempt.attempts).toBe(2);
    db.failAiJob(secondAttempt.id, "known failure again", null, secondAttempt.attempts);
    const staleRetry = await api.request(`/events/${event.id}/ai/retry`, { method: "POST", headers, body: retryBody });
    expect(staleRetry.status).toBe(409);
    expect(await staleRetry.json()).toMatchObject({ code: "AI_JOB_CHANGED", retryAllowed: false });
    expect(db.getAiJob(job.id)).toMatchObject({ status: "failed", attempts: 2 });
  });
});
