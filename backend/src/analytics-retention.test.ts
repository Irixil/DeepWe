import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_RETENTION_MS, db, pruneExpiredAnalytics } from "./db.js";
import { ANALYTICS_RETENTION_INTERVAL_MS, startAnalyticsRetention, stopAnalyticsRetention } from "./analytics-retention.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

function fixture(createdAt = T0, suffix = "old") {
  const eventId = db.prepare(`INSERT INTO analytics_events(user_id,session_id,name,step,duration_ms,created_at) VALUES('retention-synthetic-user','retention-synthetic-session','conversation_opened','private',15,?)`).run(createdAt).lastInsertRowid;
  const metricId = `retention-synthetic-${suffix}`;
  db.prepare(`INSERT INTO ai_call_metrics(id,call_kind,provider,requested_model,resolved_model,thinking,attempt,status,latency_ms,prompt_tokens,completion_tokens,reasoning_tokens,cached_tokens,total_tokens,pricing_version,created_at)
    VALUES(?,'private_reply','offline-synthetic','offline-synthetic','offline-synthetic',0,1,'success',25,12,8,2,0,20,'synthetic-not-a-price',?)`).run(metricId,createdAt);
  return { eventId, metricId };
}

function counts() {
  return {
    events: (db.prepare(`SELECT COUNT(*) count FROM analytics_events`).get() as {count:number}).count,
    metrics: (db.prepare(`SELECT COUNT(*) count FROM ai_call_metrics`).get() as {count:number}).count,
    privateMessages: (db.prepare(`SELECT COUNT(*) count FROM private_messages`).get() as {count:number}).count,
  };
}

beforeEach(() => {
  expect((db.pragma("database_list") as {name:string;file:string}[]).find(row=>row.name==="main")?.file).toBe("");
  stopAnalyticsRetention();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network forbidden in offline retention test"))));
  db.exec(`DROP TRIGGER IF EXISTS retention_synthetic_failure; DELETE FROM analytics_events; DELETE FROM ai_call_metrics; DELETE FROM private_messages;`);
});

afterEach(() => {
  stopAnalyticsRetention();
  db.exec(`DROP TRIGGER IF EXISTS retention_synthetic_failure`);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("METRICS2 runtime retention, synthetic clock and in-memory rows only", () => {
  it("cleans both tables at startup/exact 90-day boundary while preserving future metadata and old private content", () => {
    fixture(T0 - ANALYTICS_RETENTION_MS - 1,"expired");
    fixture(T0 - ANALYTICS_RETENTION_MS,"boundary");
    const notDue = fixture(T0 - ANALYTICS_RETENTION_MS + 1,"not-due");
    const fresh = fixture(T0 - DAY,"fresh");
    const keptBefore = db.prepare(`SELECT * FROM ai_call_metrics WHERE id IN (?,?) ORDER BY id`).all(notDue.metricId,fresh.metricId);
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,version,status,created_at) VALUES('retention-synthetic-message','retention-synthetic-conversation','user','仅供内存测试的合成私密原话',3,'current',?)`).run(T0 - 120 * DAY);
    const privateBefore = db.prepare(`SELECT * FROM private_messages`).all();
    startAnalyticsRetention();
    expect(counts()).toEqual({events:2,metrics:2,privateMessages:1});
    expect(db.prepare(`SELECT * FROM ai_call_metrics ORDER BY id`).all()).toEqual(keptBefore);
    expect(db.prepare(`SELECT * FROM private_messages`).all()).toEqual(privateBefore);
    expect(db.prepare(`SELECT id FROM analytics_events ORDER BY id`).all()).toEqual([{id:notDue.eventId},{id:fresh.eventId}]);
  });

  it("deletes 91-day-old rows without dashboard reads, new event writes or model/network calls", async () => {
    fixture();
    db.prepare(`INSERT INTO private_messages(id,conversation_id,role,content,created_at) VALUES('retention-synthetic-message','retention-synthetic-conversation','user','仅供内存测试的合成私密原话',?)`).run(T0);
    startAnalyticsRetention();
    expect(counts()).toEqual({events:1,metrics:1,privateMessages:1});
    await vi.advanceTimersByTimeAsync(91 * DAY);
    const observed = counts();
    console.log(JSON.stringify({syntheticClockUtc:new Date(Date.now()).toISOString(),idleDays:91,ownerDashboardReads:0,newAnalyticsWritesAfterSeed:0,observed,fetchCalls:vi.mocked(fetch).mock.calls.length}));
    expect(observed).toEqual({events:0,metrics:0,privateMessages:1});
  });

  it("schedules existing rows at their 90-day deadline instead of waiting for the hourly fallback", async () => {
    fixture();
    vi.setSystemTime(T0 + ANALYTICS_RETENTION_MS - 30_000);
    const timers = vi.spyOn(globalThis,"setTimeout");
    startAnalyticsRetention();
    expect(timers.mock.calls[0]?.[1]).toBe(30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(counts().events).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(counts()).toEqual({events:0,metrics:0,privateMessages:0});
    expect(vi.getTimerCount()).toBe(1);
    expect(timers.mock.calls.at(-1)?.[1]).toBe(ANALYTICS_RETENTION_INTERVAL_MS);
  });

  it.each(["analytics_events","ai_call_metrics"])("uses the earliest expiry from %s and keeps the later table until its own deadline", async table => {
    fixture(T0 - ANALYTICS_RETENTION_MS + 20_000);
    db.prepare(`UPDATE ${table} SET created_at=?`).run(T0 - ANALYTICS_RETENTION_MS + 10_000);
    const timers = vi.spyOn(globalThis,"setTimeout");
    startAnalyticsRetention();
    expect(timers.mock.calls[0]?.[1]).toBe(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(counts()).toEqual(table==="analytics_events"?{events:0,metrics:1,privateMessages:0}:{events:1,metrics:0,privateMessages:0});
    expect(timers.mock.calls.at(-1)?.[1]).toBe(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(counts()).toEqual({events:0,metrics:0,privateMessages:0});
  });

  it("uses one unref timer, hourly fallback with empty rows and idempotent repeated startup", () => {
    const timers = vi.spyOn(globalThis,"setTimeout");
    startAnalyticsRetention();
    startAnalyticsRetention();
    expect(timers).toHaveBeenCalledTimes(1);
    expect(timers.mock.calls[0]?.[1]).toBe(60 * 60 * 1000);
    expect((timers.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    stopAnalyticsRetention();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not claim cleanup while stopped; next startup immediately catches up", async () => {
    fixture();
    startAnalyticsRetention();
    stopAnalyticsRetention();
    await vi.advanceTimersByTimeAsync(91 * DAY);
    expect(counts()).toEqual({events:1,metrics:1,privateMessages:0});
    startAnalyticsRetention();
    expect(counts()).toEqual({events:0,metrics:0,privateMessages:0});
  });

  it("retries failed cleanup after one hour without logging exception, SQL or private content", async () => {
    fixture(T0 - ANALYTICS_RETENTION_MS + 1);
    startAnalyticsRetention();
    const errors = vi.spyOn(console,"error").mockImplementation(()=>undefined);
    vi.spyOn(db,"prepare").mockImplementationOnce(()=>{throw new Error("synthetic sensitive exception body");});
    await vi.advanceTimersByTimeAsync(1);
    expect(counts().events).toBe(1);
    expect(errors).toHaveBeenCalledExactlyOnceWith("Analytics retention cleanup failed; retrying on the next interval");
    await vi.advanceTimersByTimeAsync(ANALYTICS_RETENTION_INTERVAL_MS);
    expect(counts().events).toBe(0);
    expect(counts().metrics).toBe(0);
  });

  it("shares the database cutoff rule and reports actual deletions idempotently", () => {
    fixture(T0 - ANALYTICS_RETENTION_MS,"boundary");
    fixture(T0 - ANALYTICS_RETENTION_MS + 1,"not-due");
    expect(pruneExpiredAnalytics(T0)).toEqual({analyticsEvents:1,aiCallMetrics:1});
    expect(pruneExpiredAnalytics(T0)).toEqual({analyticsEvents:0,aiCallMetrics:0});
    expect(pruneExpiredAnalytics(T0 + 1)).toEqual({analyticsEvents:1,aiCallMetrics:1});
  });

  it("rolls back both tables on failure and does not start a partial startup timer", () => {
    fixture(T0 - 91 * DAY);
    db.exec(`CREATE TEMP TRIGGER retention_synthetic_failure BEFORE DELETE ON ai_call_metrics BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END`);
    expect(()=>startAnalyticsRetention()).toThrow("synthetic cleanup failure");
    expect(counts()).toEqual({events:1,metrics:1,privateMessages:0});
    expect(vi.getTimerCount()).toBe(0);
    db.exec(`DROP TRIGGER retention_synthetic_failure`);
    startAnalyticsRetention();
    expect(counts()).toEqual({events:0,metrics:0,privateMessages:0});
  });

  it("runs the real entry wiring with env loading, restore, server and workers stubbed; cleanup precedes initial persistence", async () => {
    fixture(T0 - 91 * DAY);
    const order:string[]=[];
    vi.doMock("node:process",async importOriginal=>({
      ...await importOriginal<typeof import("node:process")>(),
      loadEnvFile:vi.fn(()=>order.push("env-loader-stub")),
    }));
    vi.doMock("@hono/node-server",()=>({serve:vi.fn(()=>{order.push("serve-stub");})}));
    vi.doMock("./routes.js",()=>({default:{fetch:vi.fn()}}));
    vi.doMock("./ai-worker.js",()=>({startAiWorker:vi.fn(()=>order.push("ai-worker-stub"))}));
    vi.doMock("./private-ai-worker.js",()=>({startPrivateWorker:vi.fn(()=>order.push("private-worker-stub"))}));
    vi.doMock("./persistence.js",()=>({
      restoreDatabaseBeforeStart:vi.fn(async()=>{order.push("restore-stub");}),
      startDatabasePersistence:vi.fn(async()=>{
        expect(counts()).toEqual({events:0,metrics:0,privateMessages:0});
        order.push("initial-persistence-stub-after-cleanup");
      }),
    }));
    await import("./index.js");
    expect(order).toEqual(["env-loader-stub","restore-stub","initial-persistence-stub-after-cleanup","ai-worker-stub","private-worker-stub","serve-stub"]);
    expect(vi.getTimerCount()).toBe(1);
    console.log(JSON.stringify({entryWiring:"index.ts actual import; all external/startup side effects stubbed",order,observed:counts(),fetchCalls:vi.mocked(fetch).mock.calls.length}));
  });
});
