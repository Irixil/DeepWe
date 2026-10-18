import { loadEnvFile } from "node:process";
import { serve } from "@hono/node-server";
import { restoreDatabaseBeforeStart } from "./persistence.js";

// 加载本地环境变量（DEEPSEEK_API_KEY）
try {
  loadEnvFile(".env.local");
} catch {
  /* 无 .env.local 时使用 mock */
}

await restoreDatabaseBeforeStart();

// SQLite 必须等持久副本恢复完成后再打开，所以应用模块在这里动态加载。
const [{ default: api }, { startAiWorker }, { startPrivateWorker }, { applyConfiguredAdminFromEnvironment }, persistence, { startAnalyticsRetention }] =
  await Promise.all([
    import("./routes.js"),
    import("./ai-worker.js"),
    import("./private-ai-worker.js"),
    import("./db.js"),
    import("./persistence.js"),
    import("./analytics-retention.js"),
  ]);

applyConfiguredAdminFromEnvironment();
startAnalyticsRetention();
await persistence.startDatabasePersistence();

const port = Number(process.env.PORT ?? 4000);

startAiWorker();
startPrivateWorker();

serve({ fetch: api.fetch, port }, (info) => {
  console.log(`DeepWe 后端运行在 http://localhost:${info.port}`);
});
