import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it("隔离旧数据库迁移保留提案内容、确认状态和风险类别，并安全初始化新字段", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deepwe-proposal-migration-"));
  const dbPath = path.join(temporary, "synthetic.db");
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE shared_memory_proposals (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
    proposed_by_user_id TEXT NOT NULL, updated_by_user_id TEXT NOT NULL, replaces_memory_id TEXT,
    a_confirmed INTEGER NOT NULL DEFAULT 0, b_confirmed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', rejected_by_user_id TEXT, rejection_reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  old.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, code TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
    a_token TEXT NOT NULL, b_token TEXT, a_user_id TEXT, b_user_id TEXT,
    risk_level TEXT NOT NULL DEFAULT 'none', created_at INTEGER NOT NULL
  )`);
  const eventId = crypto.randomUUID();
  old.prepare("INSERT INTO events(id,title,code,state,a_token,a_user_id,risk_level,created_at) VALUES(?,?,?,'safety_exit',?,?,'self_harm',1)")
    .run(eventId, "合成旧风险事件", "SYNTHETICCODE", "synthetic-token", "synthetic-a");
  const proposalId = crypto.randomUUID();
  old.prepare("INSERT INTO shared_memory_proposals(id,connection_id,category,content,proposed_by_user_id,updated_by_user_id,a_confirmed,b_confirmed,created_at,updated_at) VALUES(?,?,?,?,?,?,1,0,1,1)")
    .run(proposalId, "synthetic-connection", "communication_method", "合成旧提案原文", "synthetic-a", "synthetic-a");
  old.close();
  const shared = globalThis as unknown as { __deepweDb?: Database.Database };
  const previousDb = shared.__deepweDb;
  delete shared.__deepweDb;
  vi.stubEnv("DATA_DIR", temporary); vi.stubEnv("DEEPWE_DATABASE_PATH", dbPath);
  vi.resetModules();
  let migrated: Database.Database | undefined;
  try {
    migrated = (await import("./db")).db;
    expect(migrated.prepare("SELECT content,a_confirmed,b_confirmed,version FROM shared_memory_proposals WHERE id=?").get(proposalId))
      .toEqual({ content: "合成旧提案原文", a_confirmed: 1, b_confirmed: 0, version: 1 });
    expect(migrated.prepare("SELECT risk_level,risk_side FROM events WHERE id=?").get(eventId))
      .toEqual({ risk_level: "self_harm", risk_side: null });
  } finally {
    migrated?.close();
    if (previousDb) shared.__deepweDb = previousDb; else delete shared.__deepweDb;
    vi.unstubAllEnvs(); vi.resetModules();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
