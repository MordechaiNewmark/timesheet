import crypto from "node:crypto";
import { db, ready, loadState, saveState, sha256, hit, bodyOf, requireJson } from "../_lib.js";

// POST /api/v1/entries   Authorization: Bearer ts_...
// { "project": "Name", "minutes": 90 | "hours": 1.5, "date": "YYYY-MM-DD", "description": "...", "billable": true }
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  if (!requireJson(req, res)) return;
  try {
    await ready();
    const m = /^Bearer\s+(ts_[\w-]+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "Missing API key" });
    const h = sha256(m[1]);
    const k = await db().execute({ sql: "SELECT user_id FROM api_keys WHERE hash = ?", args: [h] });
    if (!k.rows.length) return res.status(401).json({ error: "Invalid API key" });
    const userId = String(k.rows[0].user_id);
    if (!(await hit("api:" + h, 120, 3600e3))) return res.status(429).json({ error: "Rate limit: 120 requests per hour" });

    const b = bodyOf(req);
    const minutes = b.minutes != null ? Number(b.minutes) : Number(b.hours) * 60;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : new Date().toISOString().slice(0, 10);
    const name = String(b.project || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "project is required" });
    if (!(minutes >= 1 && minutes <= 1440)) return res.status(400).json({ error: "minutes (or hours) must be between 1 minute and 24 hours" });

    const loaded = await loadState(userId);
    const state = loaded.state || { projects: [], entries: [], timer: null, settings: {} };
    state.projects ||= [];
    state.entries ||= [];
    let p = state.projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) {
      p = { id: crypto.randomUUID().slice(0, 8), name, client: "", rate: 0, budget: 0, color: "#5b6b78", archived: false };
      state.projects.push(p);
    }
    const id = crypto.randomUUID().slice(0, 8);
    state.entries.push({
      id, projectId: p.id, date, secs: Math.round(minutes * 60),
      desc: String(b.description || "").slice(0, 140), billable: b.billable !== false, created: Date.now(),
    });
    await saveState(userId, state);
    await db().execute({ sql: "UPDATE api_keys SET last_used = ? WHERE hash = ?", args: [Date.now(), h] });
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
