import { db, ready, getUser, requireJson } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    await ready();

    if (req.method === "GET") {
      const r = await db().execute({ sql: "SELECT v FROM state WHERE user_id = ?", args: [user.id] });
      return res.status(200).json({ state: r.rows.length ? JSON.parse(r.rows[0].v) : null });
    }
    if (req.method === "PUT") {
      if (!requireJson(req, res)) return;
      const s = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!s || !Array.isArray(s.projects) || !Array.isArray(s.entries)) {
        return res.status(400).json({ error: "invalid state" });
      }
      const v = JSON.stringify(s);
      if (v.length > 4_000_000) return res.status(413).json({ error: "too large" });
      await db().execute({
        sql: "INSERT INTO state (user_id, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
        args: [user.id, v, Date.now()],
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
