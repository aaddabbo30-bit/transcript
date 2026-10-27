// Just enough of Cloudflare D1 for the bridge, on Node's built-in SQLite, so
// the tests run the Worker's real SQL.

import { DatabaseSync } from "node:sqlite";

export function memoryD1() {
  const db = new DatabaseSync(":memory:");
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    run: async () => {
      db.prepare(sql).run(...args);
      return { success: true };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...args).map((row) => ({ ...row })) }),
    first: async () => {
      const row = db.prepare(sql).get(...args);
      return row ? { ...row } : null;
    },
    runNow: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const s of statements) s.runNow();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return statements.map(() => ({ success: true }));
    },
  };
}
