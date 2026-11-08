#!/usr/bin/env node
/** Integration runtime entrypoint: `npm run serve` (after `npm run build`). */
import { createPgDb } from "../store/db.js";
import { migrate, schemaVersion, LATEST_SCHEMA_VERSION } from "../store/migrations.js";
import { pruneExpired } from "../store/repos.js";
import { createHttpServer } from "../integrations/http.js";
import { buildRuntime, loadRuntimeConfig } from "./runtime.js";

async function main(): Promise<void> {
  const cfg = loadRuntimeConfig();
  const db = createPgDb(cfg.databaseUrl);
  if (cfg.migrateOnStart) await migrate(db);
  const v = await schemaVersion(db).catch(() => 0);
  if (v < LATEST_SCHEMA_VERSION) throw new Error(`Database schema ${v} < ${LATEST_SCHEMA_VERSION}. Run: npm run db:migrate`);
  const rt = buildRuntime({ cfg, db });
  const server = createHttpServer(rt.route, { maxBodyBytes: cfg.integrations.slack.maxBodyBytes, log: rt.log });
  const prune = setInterval(() => void pruneExpired(db).catch(() => {}), 60_000);
  prune.unref();
  server.listen(cfg.port, () => rt.log({ evt: "listening", port: cfg.port, fixtures: cfg.app.useFixtures, slack: cfg.integrations.slack.enabled, validatedOps: cfg.app.validatedOperations.join(",") }));
  const stop = (sig: string) => {
    rt.log({ evt: "shutdown", sig });
    server.close(() => void db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ evt: "fatal", message: err instanceof Error ? err.message : String(err) })}\n`);
  process.exit(1);
});
