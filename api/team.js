import crypto from "node:crypto";
import { db, ready, getUser, loadState, requireJson, bodyOf, entryAmt } from "./_lib.js";

const newCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function membership(userId) {
  const own = await db().execute({ sql: "SELECT id, name, code FROM teams WHERE owner_id = ?", args: [userId] });
  if (own.rows.length) return { id: String(own.rows[0].id), name: String(own.rows[0].name), code: String(own.rows[0].code), role: "owner" };
  const m = await db().execute({
    sql: "SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?",
    args: [userId],
  });
  if (m.rows.length) return { id: String(m.rows[0].id), name: String(m.rows[0].name), role: "member" };
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    await ready();

    if (req.method === "POST") {
      if (!requireJson(req, res)) return;
      const b = bodyOf(req);
      const cur = await membership(user.id);

      if (b.action === "create") {
        if (cur) return res.status(400).json({ error: "You are already in a team." });
        const name = String(b.name || "").trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: "Give the team a name." });
        const id = crypto.randomUUID();
        await db().execute({ sql: "INSERT INTO teams (id, owner_id, name, code, created_at) VALUES (?, ?, ?, ?, ?)", args: [id, user.id, name, newCode(), Date.now()] });
        return res.status(200).json({ ok: true });
      }
      if (b.action === "join") {
        if (cur) return res.status(400).json({ error: "You are already in a team." });
        const t = await db().execute({ sql: "SELECT id FROM teams WHERE code = ?", args: [String(b.code || "").trim().toUpperCase()] });
        if (!t.rows.length) return res.status(404).json({ error: "No team with that code." });
        const n = await db().execute({ sql: "SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?", args: [t.rows[0].id] });
        if (Number(n.rows[0].c) >= 49) return res.status(400).json({ error: "That team is full." });
        await db().execute({ sql: "INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)", args: [t.rows[0].id, user.id, Date.now()] });
        return res.status(200).json({ ok: true });
      }
      if (b.action === "leave") {
        if (cur?.role === "owner") {
          await db().batch([
            { sql: "DELETE FROM team_members WHERE team_id = ?", args: [cur.id] },
            { sql: "DELETE FROM teams WHERE id = ?", args: [cur.id] },
          ], "write");
        } else {
          await db().execute({ sql: "DELETE FROM team_members WHERE user_id = ?", args: [user.id] });
        }
        return res.status(200).json({ ok: true });
      }
      if (cur?.role !== "owner") return res.status(403).json({ error: "Only the team owner can do that." });
      if (b.action === "rotate") {
        await db().execute({ sql: "UPDATE teams SET code = ? WHERE id = ?", args: [newCode(), cur.id] });
        return res.status(200).json({ ok: true });
      }
      if (b.action === "remove") {
        await db().execute({ sql: "DELETE FROM team_members WHERE team_id = ? AND user_id = ?", args: [cur.id, String(b.userId || "")] });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "Unknown action" });
    }

    if (req.method !== "GET") return res.status(405).end();
    const cur = await membership(user.id);
    if (!cur) return res.status(200).json({ team: null });
    if (cur.role === "member") return res.status(200).json({ team: { name: cur.name, role: "member" } });

    const from = DATE.test(req.query?.from) ? req.query.from : "0000-01-01";
    const to = DATE.test(req.query?.to) ? req.query.to : "9999-12-31";
    const ms = await db().execute({
      sql: "SELECT u.id, u.email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?",
      args: [cur.id],
    });
    const people = [{ id: user.id, email: user.email, owner: true }, ...ms.rows.map((r) => ({ id: String(r.id), email: String(r.email) }))];
    const members = [];
    for (const p of people) {
      const { state } = await loadState(p.id);
      const es = ((state && state.entries) || []).filter((e) => e.date >= from && e.date <= to);
      const byProject = {};
      for (const e of es) {
        const proj = (state.projects || []).find((x) => x.id === e.projectId);
        const k = proj ? proj.name : "(deleted)";
        byProject[k] = (byProject[k] || 0) + e.secs;
      }
      members.push({
        userId: p.id,
        email: p.email,
        owner: !!p.owner,
        secs: es.reduce((x, e) => x + e.secs, 0),
        billableSecs: es.filter((e) => e.billable).reduce((x, e) => x + e.secs, 0),
        amount: state ? es.reduce((x, e) => x + entryAmt(state, e), 0) : 0,
        byProject,
      });
    }
    return res.status(200).json({ team: { name: cur.name, role: "owner", code: cur.code }, members });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
