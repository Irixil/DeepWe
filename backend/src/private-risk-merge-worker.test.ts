import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import api from "./routes";
import * as db from "./db";
import * as privateCore from "./private-core";
import { wakeAiWorker } from "./ai-worker";

const oldApiKey = process.env.DEEPSEEK_API_KEY;
const oldRouterEnabled = process.env.DEEPWE_ROUTER_ENABLED;

beforeEach(() => {
  process.env.DEEPWE_ROUTER_ENABLED = "false";
  delete process.env.DEEPWE_OWNER_USER_ID;
});

afterEach(() => {
  if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = oldApiKey;
  if (oldRouterEnabled === undefined) delete process.env.DEEPWE_ROUTER_ENABLED;
  else process.env.DEEPWE_ROUTER_ENABLED = oldRouterEnabled;
  const worker = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
  delete worker.__deepweAiWorkerRunning;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const summaryA = {
  observation: "A 合成观察到约定临时变化", feelings: ["失落"], needs: ["提前沟通"], request: "希望变动时提前告知",
};
const summaryB = {
  observation: "B 合成临时需要处理家事", feelings: ["内疚"], needs: ["被理解"], request: "希望先说明当时的情况",
};
const merged = {
  event_summary: "双方对一次临时变动有不同感受。",
  shared_facts: ["原定安排发生了变化"],
  a_view: { feelings: summaryA.feelings, needs: summaryA.needs, request: summaryA.request },
  b_view: { feelings: summaryB.feelings, needs: summaryB.needs, request: summaryB.request },
  different_views: ["双方对告知是否及时理解不同"], unresolved: [],
  repair_phrases: { a: "A 合成表达", b: "B 合成表达" },
  a_suggestions: ["A 合成建议"], a_partner_view: "A 合成伴侣视角", a_actions: ["A 合成行动"],
  b_suggestions: ["B 合成建议"], b_partner_view: "B 合成伴侣视角", b_actions: ["B 合成行动"],
};

function account(label: string) {
  const user = db.createUser(`${label}-${crypto.randomUUID()}@synthetic.invalid`, label, "synthetic-hash", "synthetic-salt");
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.createAccountSession(user.id, tokenHash, Date.now() + 60_000);
  return { user, cookie: `dw_account=${token}` };
}

function fixture() {
  const a = account("Synthetic A");
  const b = account("Synthetic B");
  const event = db.createEvent("Synthetic bound event", a.user.id);
  db.db.prepare(`UPDATE events SET state='waiting_b' WHERE id=?`).run(event.id);
  const bToken = db.randomToken();
  if (!db.setBParticipant(event.id, bToken, b.user.id)) throw new Error("synthetic B binding failed");
  db.db.prepare(`UPDATE events SET state='merged' WHERE id=?`).run(event.id);
  db.upsertPerspective(event.id, "a", "synthetic source A");
  db.upsertPerspective(event.id, "b", "synthetic source B");
  db.setSummary(event.id, "a", JSON.stringify(summaryA));
  db.setSummary(event.id, "b", JSON.stringify(summaryB));
  db.confirmSummary(event.id, "a"); db.confirmSummary(event.id, "b");
  db.upsertMerged(event.id, JSON.stringify(merged));
  const aConversation = privateCore.createConversation(a.user.id, "Synthetic A private", { eventId: event.id, side: "a" });
  const bConversation = privateCore.createConversation(b.user.id, "Synthetic B private", { eventId: event.id, side: "b" });
  return { event, a, b, aConversation, bConversation };
}

function initialMergeFixture() {
  const a = account("Synthetic initial A");
  const b = account("Synthetic initial B");
  const event = db.createEvent("Synthetic initial merge event", a.user.id);
  db.db.prepare(`UPDATE events SET state='waiting_b' WHERE id=?`).run(event.id);
  const bToken = db.randomToken();
  if (!db.setBParticipant(event.id, bToken, b.user.id)) throw new Error("synthetic B binding failed");
  db.db.prepare(`UPDATE events SET state='b_summary' WHERE id=?`).run(event.id);
  db.upsertPerspective(event.id, "a", "synthetic source A");
  db.upsertPerspective(event.id, "b", "synthetic source B");
  db.setSummary(event.id, "a", JSON.stringify(summaryA));
  db.setSummary(event.id, "b", JSON.stringify(summaryB));
  db.confirmSummary(event.id, "a");
  const aConversation = privateCore.createConversation(a.user.id, "Synthetic initial A private", { eventId: event.id, side: "a" });
  const bConversation = privateCore.createConversation(b.user.id, "Synthetic initial B private", { eventId: event.id, side: "b" });
  return { event, a, b, aConversation, bConversation };
}

function addRisk(conversationId: string) {
  db.db.prepare(`INSERT INTO private_risk_state(conversation_id,situation,source_message_ids,updated_at) VALUES(?,?,?,?)`)
    .run(conversationId, "synthetic-risk-marker", "[]", Date.now());
}

async function waitForStatus(eventId: string, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const row = db.db.prepare(`SELECT status FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(eventId) as { status: string } | undefined;
    if (row && ["completed", "cancelled", "failed"].includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return (db.db.prepare(`SELECT status FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(eventId) as { status: string } | undefined)?.status ?? "missing";
}

describe("merge worker active private-risk gate", () => {
  it("cancels a queued job before provider dispatch when linked risk is already active", async () => {
    process.env.DEEPSEEK_API_KEY = "synthetic-only";
    const fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fakeFetch);
    const f = fixture();
    const oldMerged = db.getMerged(f.event.id)!;
    const worker = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
    worker.__deepweAiWorkerRunning = true;
    const response = await api.request(`/events/${f.event.id}/merged/confirm`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: f.b.cookie },
      body: JSON.stringify({ expectedVersion: 1, correction: "感受：失落；需要：提前沟通；请求：希望变动时提前告知" }),
    });
    expect(response.status).toBe(202);
    expect(db.db.prepare(`SELECT status FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC LIMIT 1`).get(f.event.id)).toMatchObject({ status: "queued" });
    addRisk(f.aConversation.id);
    worker.__deepweAiWorkerRunning = false;
    wakeAiWorker();
    expect(await waitForStatus(f.event.id)).toBe("cancelled");
    expect(fakeFetch).toHaveBeenCalledTimes(0);
    expect(db.getMerged(f.event.id)?.version).toBe(oldMerged.version);
    expect(db.getMerged(f.event.id)?.content).toBe(oldMerged.content);
  });

  it("cancels completion if risk appears behind this request's in-flight provider barrier", async () => {
    process.env.DEEPSEEK_API_KEY = "synthetic-only";
    const f = fixture();
    const oldMerged = db.getMerged(f.event.id)!;
    let release!: () => void;
    let announceStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const fakeFetch = vi.fn(async () => {
      announceStarted();
      await gate;
      return new Response(JSON.stringify({
        id: "synthetic", model: "synthetic",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(merged) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const response = await api.request(`/events/${f.event.id}/merged/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: f.b.cookie },
        body: JSON.stringify({ expectedVersion: 1, correction: "感受：内疚；需要：被理解；请求：希望先说明当时的情况" }),
      });
      expect(response.status).toBe(202);
      await started;
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      addRisk(f.aConversation.id);
      release();
      expect(await waitForStatus(f.event.id)).toBe("cancelled");
      const saved = db.getMerged(f.event.id)!;
      expect(saved.version).toBe(oldMerged.version);
      expect(saved.content).toBe(oldMerged.content);
      expect(saved.a_confirmed).toBe(0);
      expect(saved.b_confirmed).toBe(0);
      expect(db.getAiJob((db.db.prepare(`SELECT id FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC LIMIT 1`).get(f.event.id) as { id: string }).id)?.status).toBe("cancelled");
      expect(db.getPerspective(f.event.id, "b")?.correction).toBeTruthy();
    } finally {
      release();
    }
  });

  it("cancels an in-flight initial merge on linked risk and only allows explicit B resubmission after clearing it", async () => {
    process.env.DEEPSEEK_API_KEY = "synthetic-only";
    const f = initialMergeFixture();
    let release!: () => void;
    let announceStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const fakeFetch = vi.fn(async () => {
      announceStarted();
      await gate;
      return new Response(JSON.stringify({
        id: "synthetic-initial", model: "synthetic",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(merged) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const beforeA = db.getPerspective(f.event.id, "a")!;
      const beforeB = db.getPerspective(f.event.id, "b")!;
      const confirm = () => api.request(`/events/${f.event.id}/b-summary/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: f.b.cookie }, body: JSON.stringify({}),
      });
      const response = await confirm();
      expect(response.status).toBe(202);
      await started;
      expect(fakeFetch).toHaveBeenCalledTimes(1);

      addRisk(f.aConversation.id);
      const paused = await api.request(`/events/${f.event.id}`, { headers: { Cookie: f.b.cookie } });
      const pausedBody = await paused.json();
      expect(pausedBody.sharedSafetyPaused).toBe(true);
      expect(pausedBody.state).toBe("b_summary");
      expect(pausedBody.merged).toBeNull();

      release();
      const firstJobId = (db.db.prepare(`SELECT id FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC LIMIT 1`).get(f.event.id) as { id: string }).id;
      expect(await waitForStatus(f.event.id)).toBe("cancelled");
      expect(db.getAiJob(firstJobId)?.kind).toBe("merge_initial");
      expect(db.getEvent(f.event.id)?.state).toBe("b_summary");
      expect(db.getPerspective(f.event.id, "a")).toEqual(beforeA);
      expect(db.getPerspective(f.event.id, "b")).toEqual({ ...beforeB, summary_confirmed: 1 });
      expect(db.getMerged(f.event.id)).toBeUndefined();

      const cancelled = await api.request(`/events/${f.event.id}`, { headers: { Cookie: f.b.cookie } });
      const cancelledBody = await cancelled.json();
      expect(cancelledBody.sharedSafetyPaused).toBe(true);
      expect(cancelledBody.aiJobStatus).toBe("idle");
      expect(cancelledBody.bConfirmed).toBe(true);
      expect(cancelledBody.merged).toBeNull();

      db.db.prepare(`DELETE FROM private_risk_state WHERE conversation_id=?`).run(f.aConversation.id);
      const resumed = await api.request(`/events/${f.event.id}`, { headers: { Cookie: f.b.cookie } });
      const resumedBody = await resumed.json();
      expect(resumedBody.sharedSafetyPaused).toBe(false);
      expect(resumedBody.aiJobStatus).toBe("idle");
      expect(resumedBody.bConfirmed).toBe(true);
      expect(resumedBody.merged).toBeNull();
      expect(db.getEvent(f.event.id)?.state).toBe("b_summary");
      expect(db.getMerged(f.event.id)).toBeUndefined();

      const countBefore = (db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(f.event.id) as { count: number }).count;
      const ownerAttempt = await api.request(`/events/${f.event.id}/b-summary/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: f.a.cookie }, body: JSON.stringify({}),
      });
      expect(ownerAttempt.status).toBe(403);
      expect((db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(f.event.id) as { count: number }).count).toBe(countBefore);

      const worker = globalThis as unknown as { __deepweAiWorkerRunning?: boolean };
      worker.__deepweAiWorkerRunning = true;
      const explicitRetry = await confirm();
      expect(explicitRetry.status).toBe(202);
      const secondJob = db.db.prepare(`SELECT id,status,kind FROM ai_jobs WHERE event_id=? ORDER BY created_at DESC LIMIT 1`).get(f.event.id) as { id: string; status: string; kind: string };
      expect(secondJob).toMatchObject({ status: "queued", kind: "merge_initial" });
      const duplicate = await confirm();
      expect(duplicate.status).toBe(409);
      expect((db.db.prepare(`SELECT COUNT(*) count FROM ai_jobs WHERE event_id=?`).get(f.event.id) as { count: number }).count).toBe(countBefore + 1);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      db.cancelAiJob(secondJob.id);
    } finally {
      release();
    }
  });
});
