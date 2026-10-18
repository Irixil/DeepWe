import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = {
  databasePath: process.env.DEEPWE_DATABASE_PATH,
  persistentDir: process.env.DEEPWE_PERSISTENT_DIR,
  required: process.env.DEEPWE_PERSISTENCE_REQUIRED,
};

let temporaryRoot: string | undefined;
let openApplicationDatabase: Database.Database | undefined;

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries({
    DEEPWE_DATABASE_PATH: originalEnvironment.databasePath,
    DEEPWE_PERSISTENT_DIR: originalEnvironment.persistentDir,
    DEEPWE_PERSISTENCE_REQUIRED: originalEnvironment.required,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  openApplicationDatabase?.close();
  openApplicationDatabase = undefined;
  delete (globalThis as unknown as { __deepweDb?: Database.Database }).__deepweDb;
  delete (globalThis as unknown as { __deepwePersistenceState?: unknown })
    .__deepwePersistenceState;
  restoreEnvironment();
  vi.resetModules();
  if (temporaryRoot) await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

async function configurePersistentPaths(): Promise<{
  localPath: string;
  remotePath: string;
}> {
  temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deepwe-persistence-"));
  const localPath = path.join(temporaryRoot, "local", "deepwe.db");
  const persistentDir = path.join(temporaryRoot, "persistent");
  const remotePath = path.join(persistentDir, "deepwe.db");
  await fs.promises.mkdir(persistentDir, { recursive: true });
  process.env.DEEPWE_DATABASE_PATH = localPath;
  process.env.DEEPWE_PERSISTENT_DIR = persistentDir;
  process.env.DEEPWE_PERSISTENCE_REQUIRED = "true";
  return { localPath, remotePath };
}

describe("SQLite 持久化快照", () => {
  it("冷启动先恢复快照，后续改动再写回持久目录", async () => {
    const { localPath, remotePath } = await configurePersistentPaths();
    const seed = new Database(remotePath);
    seed.exec("CREATE TABLE seed_marker (value TEXT NOT NULL); INSERT INTO seed_marker VALUES ('ready')");
    seed.close();

    const persistence = await import("./persistence");
    await expect(persistence.restoreDatabaseBeforeStart()).resolves.toBe("restored");
    expect(fs.existsSync(localPath)).toBe(true);

    const databaseModule = await import("./db");
    openApplicationDatabase = databaseModule.db;
    const restored = databaseModule.db
      .prepare("SELECT value FROM seed_marker")
      .get() as { value: string };
    expect(restored.value).toBe("ready");

    databaseModule.createEvent("持久化测试");
    await persistence.persistDatabaseIfChanged(true);

    const persistentCopy = new Database(remotePath, { readonly: true });
    expect(persistentCopy.pragma("quick_check", { simple: true })).toBe("ok");
    expect(
      (persistentCopy.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number })
        .count
    ).toBe(1);
    persistentCopy.close();
  });

  it("拒绝用损坏的远端文件覆盖本机数据库", async () => {
    const { localPath, remotePath } = await configurePersistentPaths();
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const local = new Database(localPath);
    local.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('keep-me')");
    local.close();
    const originalHash = crypto.createHash("sha256").update(await fs.promises.readFile(localPath)).digest("hex");
    await fs.promises.writeFile(remotePath, "not-a-sqlite-database");

    const persistence = await import("./persistence");
    await expect(persistence.restoreDatabaseBeforeStart()).rejects.toThrow(
      "Persistent database restore failed"
    );
    const currentHash = crypto.createHash("sha256").update(await fs.promises.readFile(localPath)).digest("hex");
    expect(currentHash).toBe(originalHash);
  });

  it("上传中断仍保留上一份完整快照，清理本轮临时文件并允许恢复和重试", async () => {
    const { localPath, remotePath } = await configurePersistentPaths();
    const seed = new Database(remotePath);
    seed.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('last-good-synthetic-snapshot')");
    seed.close();
    const before = await fs.promises.readFile(remotePath);
    const persistence = await import("./persistence");
    await expect(persistence.restoreDatabaseBeforeStart()).resolves.toBe("restored");
    const databaseModule = await import("./db");
    openApplicationDatabase = databaseModule.db;
    databaseModule.createEvent("合成上传中断前的新记录");
    const writeStream = fs.createWriteStream.bind(fs);
    const interrupted = vi.spyOn(fs, "createWriteStream").mockImplementation((destination, options) => {
      if (path.dirname(String(destination)) !== path.dirname(remotePath)) return writeStream(destination, options);
      return new Writable({ write(chunk: Buffer, _encoding, callback) {
        fs.writeFileSync(destination, chunk.subarray(0, 64));
        callback(new Error("synthetic upload interruption"));
      } }) as unknown as fs.WriteStream;
    });
    await expect(persistence.persistDatabaseIfChanged(true)).rejects.toThrow("synthetic upload interruption");
    interrupted.mockRestore();
    expect(crypto.createHash("sha256").update(await fs.promises.readFile(remotePath)).digest("hex"))
      .toBe(crypto.createHash("sha256").update(before).digest("hex"));
    expect(await fs.promises.readdir(path.dirname(remotePath))).toEqual(["deepwe.db"]);
    expect((await fs.promises.readdir(path.dirname(localPath))).filter(name => name.startsWith(".deepwe-snapshot-"))).toEqual([]);
    await expect(persistence.persistDatabaseIfChanged(true)).resolves.toBeUndefined();
    const successful = new Database(remotePath, { readonly: true });
    expect(successful.pragma("quick_check", { simple: true })).toBe("ok");
    expect((successful.prepare("SELECT COUNT(*) count FROM events").get() as { count: number }).count).toBe(1);
    successful.close();
  });
});
