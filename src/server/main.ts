#!/usr/bin/env node
/** Integration runtime entrypoint: `pnpm run serve` (after `pnpm run build`). */
import { createPgDb } from "../store/db.js";
import { migrate, migrationStatus } from "../store/migrations.js";
import { pruneExpired } from "../store/repos.js";
import { createHttpServer } from "../integrations/http.js";
import { buildRuntime, loadRuntimeConfig } from "./runtime.js";

async function main(): Promise<void> {
  const cfg = loadRuntimeConfig();
  const db = createPgDb(cfg.databaseUrl);
  if (cfg.migrateOnStart) await migrate(db);
  const st = await migrationStatus(db);
  if (st.state !== "up_to_date") throw new Error(`Database schema ${st.current} / ${st.latest}: ${st.state}${st.problem ? ` (${st.problem})` : ""}. Run: pnpm db:status, then pnpm db:migrate`);
  const rt = buildRuntime({ cfg, db });
  const server = createHttpServer(rt.route, { maxBodyBytes: cfg.integrations.slack.maxBodyBytes, log: rt.log });
  const prune = setInterval(() => void pruneExpired(db).catch(() => {}), 60_000);
  prune.unref();
  server.listen(cfg.port, () => rt.log({ evt: "listening", port: cfg.port, fixtures: cfg.app.useFixtures, slack: cfg.integrations.slack.enabled, validatedOps: cfg.app.validatedOperations.join(",") }));
  const stop = (sig: string) => {
    rt.log({ evt: "shutdown", sig });
    // Stop accepting requests, let post-ack Slack work finish (each task is time-bounded), then close the pool.
    server.close(() => void rt.background.drain(8_000).then((left) => {
      if (left) rt.log({ evt: "shutdown_background_abandoned", tasks: left });
    }).finally(() => void db.close().finally(() => process.exit(0))));
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ evt: "fatal", message: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
