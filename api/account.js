import crypto from "node:crypto";
import {
  db, ready, getUser, requireJson, bodyOf, hashPassword, verifyPassword, clearCookie, sha256, hit,
} from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  if (!requireJson(req, res)) return;
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    await ready();
    const b = bodyOf(req);

    if (b.action === "keys-list") {
      const r = await db().execute({ sql: "SELECT hash, label, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY created_at", args: [user.id] });
      return res.status(200).json({ keys: r.rows.map((k) => ({ id: String(k.hash).slice(0, 12), label: String(k.label), created: Number(k.created_at), lastUsed: k.last_used ? Number(k.last_used) : null })) });
    }
    if (b.action === "keys-create") {
      const n = await db().execute({ sql: "SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?", args: [user.id] });
      if (Number(n.rows[0].c) >= 5) return res.status(400).json({ error: "Maximum 5 API keys." });
      const key = "ts_" + crypto.randomBytes(24).toString("base64url");
      await db().execute({
        sql: "INSERT INTO api_keys (hash, user_id, label, created_at) VALUES (?, ?, ?, ?)",
        args: [sha256(key), user.id, String(b.label || "API key").slice(0, 40), Date.now()],
      });
      return res.status(200).json({ key });
    }
    if (b.action === "keys-revoke") {
      await db().execute({ sql: "DELETE FROM api_keys WHERE user_id = ? AND substr(hash, 1, 12) = ?", args: [user.id, String(b.id || "")] });
      return res.status(200).json({ ok: true });
    }

    if (b.action === "password" || b.action === "delete") {
      if (!(await hit("acct:" + user.id, 10, 15 * 60e3))) return res.status(429).json({ error: "Too many attempts. Try again later." });
      const r = await db().execute({ sql: "SELECT pw_hash FROM users WHERE id = ?", args: [user.id] });
      const ok = r.rows.length && (await verifyPassword(String(b.current || ""), String(r.rows[0].pw_hash)));
      if (!ok) return res.status(403).json({ error: "Current password is incorrect." });

      if (b.action === "password") {
        const next = String(b.next || "");
        if (next.length < 8 || next.length > 200) return res.status(400).json({ error: "New password must be 8 to 200 characters." });
        await db().execute({ sql: "UPDATE users SET pw_hash = ? WHERE id = ?", args: [await hashPassword(next), user.id] });
        return res.status(200).json({ ok: true });
      }

      // delete account and everything tied to it
      const t = await db().execute({ sql: "SELECT id FROM teams WHERE owner_id = ?", args: [user.id] });
      const stmts = [
        { sql: "DELETE FROM state WHERE user_id = ?", args: [user.id] },
        { sql: "DELETE FROM portal_links WHERE user_id = ?", args: [user.id] },
        { sql: "DELETE FROM api_keys WHERE user_id = ?", args: [user.id] },
        { sql: "DELETE FROM team_members WHERE user_id = ?", args: [user.id] },
        { sql: "DELETE FROM limits WHERE k LIKE ?", args: ["%" + user.id + "%"] },
      ];
      for (const row of t.rows) {
        stmts.push({ sql: "DELETE FROM team_members WHERE team_id = ?", args: [row.id] });
        stmts.push({ sql: "DELETE FROM teams WHERE id = ?", args: [row.id] });
      }
      stmts.push({ sql: "DELETE FROM users WHERE id = ?", args: [user.id] });
      await db().batch(stmts, "write");
      res.setHeader("Set-Cookie", clearCookie());
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
