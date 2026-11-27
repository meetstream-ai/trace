import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configureToolEnvironment } from "./tool-environment.mjs";

export const localDatabase = {
  binding: "DB",
  database_name: "site-creator-d1",
  database_id: "00000000-0000-4000-8000-000000000000",
};

export async function migrateLocal() {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const root = new URL("../", import.meta.url);
  configureToolEnvironment(fileURLToPath(root));
  const journal = JSON.parse(
    readFileSync(new URL("drizzle/meta/_journal.json", root), "utf8"),
  );
  const migrations = journal.entries.map(({ tag }) => ({
    tag,
    statements: readFileSync(new URL(`drizzle/${tag}.sql`, root), "utf8")
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter(Boolean),
  }));
  const migrationWorker = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      modules: true,
      script: `
      export default { async fetch(_request, { DB }) {
        const migrations = ${JSON.stringify(migrations)};
        // Earlier setup instructions applied the first three migrations by hand.
        const schema = new Set((await DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table'"
        ).all()).results.map(({name}) => name));
        const legacy = [
          schema.has("meetings") && schema.has("deliveries"),
          ["integration_settings", "login_limits", "preferences", "sessions"]
            .every((table) => schema.has(table)),
          ["audit_log", "members", "workspaces"].every((table) => schema.has(table))
            && (await DB.prepare("PRAGMA table_info(sessions)").all()).results
              .some(({name}) => name === "actor"),
        ];
        await DB.prepare("CREATE TABLE IF NOT EXISTS trace_local_migrations (name TEXT PRIMARY KEY)").run();
        const applied = new Set((await DB.prepare("SELECT name FROM trace_local_migrations").all())
          .results.map(({name}) => name));
        let count = 0;
        for (const [index, migration] of migrations.entries()) {
          if (applied.has(migration.tag)) continue;
          const record = DB.prepare("INSERT INTO trace_local_migrations(name) VALUES (?)").bind(migration.tag);
          if (legacy[index]) await record.run();
          else {
            await DB.batch([...migration.statements.map((sql) => DB.prepare(sql)), record]);
            count++;
          }
        }
        return Response.json({ count });
      }};
    `,
      d1Databases: { DB: localDatabase.database_id },
      resourcePersistencePath: fileURLToPath(
        new URL(".wrangler/state/v3", root),
      ),
    }),
  );
  try {
    const response = await migrationWorker.dispatchFetch("http://127.0.0.1/");
    if (!response.ok)
      throw new Error(
        `Could not migrate the local database (HTTP ${response.status}).`,
      );
    const { count } = await response.json();
    if (count) console.log(`Applied ${count} local database migration(s).`);
  } finally {
    await migrationWorker.dispose();
  }
}
