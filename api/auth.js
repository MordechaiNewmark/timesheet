import crypto from "node:crypto";
import {
  db, ready, hashPassword, verifyPassword, sessionCookie, clearCookie,
  getUser, hit, requireJson, clientIp,
} from "./_lib.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const needsCode = !!process.env.SIGNUP_CODE;

    if (req.method === "GET") {
      const user = await getUser(req);
      if (!user) return res.status(401).json({ user: null, needsCode });
      return res.status(200).json({ user, needsCode });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).end();
    }
    if (!requireJson(req, res)) return;
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    if (b.action === "logout") {
      res.setHeader("Set-Cookie", clearCookie());
      return res.status(200).json({ ok: true });
    }

    const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
    const password = String(b.password || "");
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: "Password must be 8 to 200 characters." });
    }

    await ready();
    // brute-force guard: per email and per IP, 10 tries / 15 min
    const okEmail = await hit("auth:e:" + email, 10, 15 * 60e3);
    const okIp = await hit("auth:i:" + clientIp(req), 30, 15 * 60e3);
    if (!okEmail || !okIp) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });

    if (b.action === "register") {
      if (needsCode && String(b.code || "") !== process.env.SIGNUP_CODE) {
        return res.status(403).json({ error: "Invalid invite code." });
      }
      const exists = await db().execute({ sql: "SELECT 1 FROM users WHERE email = ?", args: [email] });
      if (exists.rows.length) return res.status(409).json({ error: "An account with that email already exists." });
      const id = crypto.randomUUID();
      await db().execute({
        sql: "INSERT INTO users (id, email, pw_hash, created_at) VALUES (?, ?, ?, ?)",
        args: [id, email, await hashPassword(password), Date.now()],
      });
      res.setHeader("Set-Cookie", sessionCookie(id));
      return res.status(200).json({ user: { id, email } });
    }

    if (b.action === "login") {
      const r = await db().execute({ sql: "SELECT id, pw_hash FROM users WHERE email = ?", args: [email] });
      // always run a hash so timing doesn't reveal whether the email exists
      const stored = r.rows.length ? String(r.rows[0].pw_hash) : "s1$" + "00".repeat(16) + "$" + "00".repeat(64);
      const ok = await verifyPassword(password, stored);
      if (!r.rows.length || !ok) return res.status(401).json({ error: "Wrong email or password." });
      const id = String(r.rows[0].id);
      res.setHeader("Set-Cookie", sessionCookie(id));
      return res.status(200).json({ user: { id, email } });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server is not configured yet (database or session secret)." });
  }
}
