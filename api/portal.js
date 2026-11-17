import crypto from "node:crypto";
import { db, ready, getUser, loadState, requireJson, bodyOf, clientIp, hit, entryAmt } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    await ready();

    // Public, read-only: a client views their project via a secret link.
    if (req.method === "GET") {
      if (!(await hit("portal:" + clientIp(req), 60, 60e3))) return res.status(429).json({ error: "Too many requests" });
      const t = String(req.query?.t || "");
      if (!/^[\w-]{10,64}$/.test(t)) return res.status(404).json({ error: "Link not found" });
      const l = await db().execute({ sql: "SELECT user_id, project_id FROM portal_links WHERE token = ?", args: [t] });
      if (!l.rows.length) return res.status(404).json({ error: "Link not found or revoked" });
      const { state } = await loadState(String(l.rows[0].user_id));
      const pid = String(l.rows[0].project_id);
      const p = state && (state.projects || []).find((x) => x.id === pid);
      if (!p) return res.status(404).json({ error: "Project no longer exists" });
      const sym = state.settings?.currency || "$";
      const es = (state.entries || []).filter((e) => e.projectId === pid).sort((a, b) => (a.date < b.date ? 1 : -1));
      const showMoney = p.rate > 0;
      return res.status(200).json({
        project: { name: p.name, client: p.client || "" },
        business: state.settings?.biz?.name || "",
        currency: sym,
        showMoney,
        totals: {
          secs: es.reduce((x, e) => x + e.secs, 0),
          billableSecs: es.filter((e) => e.billable).reduce((x, e) => x + e.secs, 0),
          amount: showMoney ? es.reduce((x, e) => x + entryAmt(state, e), 0) : 0,
        },
        entries: es.slice(0, 500).map((e) => ({ date: e.date, desc: e.desc || "", secs: e.secs, billable: !!e.billable })),
        invoices: (state.invoices || [])
          .filter((i) => i.projectId === pid && i.status !== "draft")
          .map((i) => ({ no: i.no, issued: i.issued, due: i.due, status: i.status, total: i.total })),
        payUrl: state.settings?.biz?.payUrl || "",
      });
    }

    if (req.method !== "POST") return res.status(405).end();
    if (!requireJson(req, res)) return;
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    const b = bodyOf(req);

    if (b.action === "list") {
      const r = await db().execute({ sql: "SELECT token, project_id FROM portal_links WHERE user_id = ?", args: [user.id] });
      return res.status(200).json({ links: r.rows.map((x) => ({ token: String(x.token), projectId: String(x.project_id) })) });
    }
    if (b.action === "create") {
      const { state } = await loadState(user.id);
      const pid = String(b.projectId || "");
      if (!state || !(state.projects || []).some((p) => p.id === pid)) {
        return res.status(400).json({ error: "Save your data first, then share the project." });
      }
      const ex = await db().execute({ sql: "SELECT token FROM portal_links WHERE user_id = ? AND project_id = ?", args: [user.id, pid] });
      if (ex.rows.length) return res.status(200).json({ token: String(ex.rows[0].token) });
      const token = crypto.randomBytes(18).toString("base64url");
      await db().execute({ sql: "INSERT INTO portal_links (token, user_id, project_id, created_at) VALUES (?, ?, ?, ?)", args: [token, user.id, pid, Date.now()] });
      return res.status(200).json({ token });
    }
    if (b.action === "revoke") {
      await db().execute({ sql: "DELETE FROM portal_links WHERE token = ? AND user_id = ?", args: [String(b.token || ""), user.id] });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
