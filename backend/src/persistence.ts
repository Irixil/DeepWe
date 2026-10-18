import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

type PersistenceState = {
  lastPersistedChanges: number | null;
  queue: Promise<void>;
  timer?: NodeJS.Timeout;
};

const globalState = globalThis as unknown as {
  __deepwePersistenceState?: PersistenceState;
};

const state =
  globalState.__deepwePersistenceState ??
  (globalState.__deepwePersistenceState = {
    lastPersistedChanges: null,
    queue: Promise.resolve(),
  });

function configuredDatabasePath(): string {
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
  return (
    process.env.DEEPWE_DATABASE_PATH ??
    (process.env.NODE_ENV === "test" ? ":memory:" : path.join(dataDir, "deepwe.db"))
  );
}

function persistentDatabasePath(): string | null {
  const persistentDir = process.env.DEEPWE_PERSISTENT_DIR?.trim();
  if (!persistentDir || configuredDatabasePath() === ":memory:") return null;
  return path.join(persistentDir, "deepwe.db");
}

/** Configuration evidence only; the forced snapshot must still succeed. */
export function databasePersistenceConfigured(): boolean {
  const persistentPath=persistentDatabasePath();
  return persistentPath!==null && path.resolve(persistentPath)!==path.resolve(configuredDatabasePath());
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertHealthyDatabase(databasePath: string): void {
  const candidate = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const result = candidate.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error("SQLite quick_check failed");
  } finally {
    candidate.close();
  }
}

async function removeTemporaryFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function copyFileContents(sourcePath: string, destinationPath: string): Promise<void> {
  await pipeline(
    fs.createReadStream(sourcePath),
    fs.createWriteStream(destinationPath, { flags: "w" })
  );
}

/**
 * Cold-start restore. This function deliberately has no static import of db.ts:
 * it must finish before the application opens SQLite.
 */
export async function restoreDatabaseBeforeStart(): Promise<
  "disabled" | "restored" | "missing"
> {
  const remotePath = persistentDatabasePath();
  if (!remotePath) return "disabled";

  const localPath = configuredDatabasePath();
  const restoreCandidate = `${localPath}.restore-${crypto.randomUUID()}`;
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

  try {
    await copyFileContents(remotePath, restoreCandidate);
    assertHealthyDatabase(restoreCandidate);
    await fs.promises.rename(restoreCandidate, localPath);
    return "restored";
  } catch (error) {
    await removeTemporaryFile(restoreCandidate);
    if (isMissingFile(error)) {
      if (process.env.DEEPWE_PERSISTENCE_REQUIRED === "true") {
        throw new Error("Persistent database is required but no snapshot is available");
      }
      return "missing";
    }
    throw new Error("Persistent database restore failed", { cause: error });
  }
}

function databaseChanges(database: Database.Database): number {
  const row = database.prepare("SELECT total_changes() AS count").get() as { count: number };
  return Number(row.count);
}

async function writeDatabaseSnapshot(force: boolean): Promise<void> {
  const remotePath = persistentDatabasePath();
  if (!remotePath) return;

  const { db } = await import("./db.js");
  const changesBeforeBackup = databaseChanges(db);
  if (!force && state.lastPersistedChanges === changesBeforeBackup) return;

  const localPath = configuredDatabasePath();
  const snapshotPath = path.join(
    path.dirname(localPath),
    `.deepwe-snapshot-${crypto.randomUUID()}.db`
  );
  const uploadPath = path.join(path.dirname(remotePath), `.deepwe-upload-${crypto.randomUUID()}.db`);

  await fs.promises.mkdir(path.dirname(remotePath), { recursive: true });
  try {
    await db.backup(snapshotPath);
    assertHealthyDatabase(snapshotPath);
    // Stream to a sibling first. Interrupted writes must never truncate the
    // last healthy snapshot. Replacement requires same-directory rename support
    // and must be checked on a deployment's mounted storage before release.
    await copyFileContents(snapshotPath, uploadPath);
    assertHealthyDatabase(uploadPath);
    await fs.promises.rename(uploadPath, remotePath);
    state.lastPersistedChanges = changesBeforeBackup;
  } finally {
    await removeTemporaryFile(snapshotPath);
    await removeTemporaryFile(uploadPath);
  }
}

/** Serialize uploads so two requests cannot overwrite the persistent copy out of order. */
export function persistDatabaseIfChanged(force = false): Promise<void> {
  if (!persistentDatabasePath()) return Promise.resolve();
  const current = state.queue.then(() => writeDatabaseSnapshot(force));
  state.queue = current.catch(() => undefined);
  return current;
}

export async function startDatabasePersistence(): Promise<void> {
  if (!persistentDatabasePath()) return;
  await persistDatabaseIfChanged(true);
  if (state.timer) return;

  const configuredInterval = Number(process.env.DEEPWE_PERSISTENCE_INTERVAL_MS ?? 5000);
  const intervalMs = Number.isFinite(configuredInterval)
    ? Math.max(1000, configuredInterval)
    : 5000;
  state.timer = setInterval(() => {
    void persistDatabaseIfChanged().catch(() => {
      console.error("Persistent database snapshot failed; retrying automatically");
    });
  }, intervalMs);
  state.timer.unref();
}
