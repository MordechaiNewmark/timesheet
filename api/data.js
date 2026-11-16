import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let ready;
function init() {
  ready ??= db.execute(
    "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  );
  return ready;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    await init();
    if (req.method === "GET") {
      const r = await db.execute({ sql: "SELECT v FROM kv WHERE k = ?", args: ["state"] });
      return res.status(200).json({ state: r.rows.length ? JSON.parse(r.rows[0].v) : null });
    }
    if (req.method === "PUT") {
      const s = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!s || !Array.isArray(s.projects) || !Array.isArray(s.entries)) {
        return res.status(400).json({ error: "invalid state" });
      }
      await db.execute({
        sql: "INSERT INTO kv (k, v, updated_at) VALUES ('state', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
        args: [JSON.stringify(s), Date.now()],
      });
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, PUT");
    return res.status(405).end();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "database error" });
  }
}
