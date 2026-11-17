import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;

let _db;
let _ready;

export function db() {
  _db ??= createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return _db;
}

export async function ready() {
  _ready ??= db()
    .batch(
      [
        "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS state (user_id TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS portal_links (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL)",
        "CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER)",
        "CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)",
      ],
      "write"
    )
    .catch((e) => {
      _ready = null;
      throw e;
    });
  return _ready;
}

/* ---------- passwords ---------- */
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return "s1$" + salt.toString("hex") + "$" + h.toString("hex");
}

export async function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored).split("$");
  if (v !== "s1" || !salt || !hash) return false;
  const h = await scrypt(pw, Buffer.from(salt, "hex"), 64);
  const expected = Buffer.from(hash, "hex");
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}

/* ---------- sessions ---------- */
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET is not configured");
  return s;
}
const sig = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

export function sessionCookie(userId) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const data = userId + "." + exp;
  return `ts_session=${data}.${sig(data)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = () => "ts_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

export async function getUser(req) {
  const m = /(?:^|;\s*)ts_session=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, s] = parts;
  const want = sig(uid + "." + exp);
  const a = Buffer.from(s);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(Number(exp) > Date.now())) return null;
  await ready();
  const r = await db().execute({ sql: "SELECT id, email FROM users WHERE id = ?", args: [uid] });
  return r.rows.length ? { id: String(r.rows[0].id), email: String(r.rows[0].email) } : null;
}

/* ---------- rate limiting (fixed window, stored in the DB) ---------- */
export async function hit(key, max, windowMs) {
  await ready();
  const now = Date.now();
  const r = await db().execute({ sql: "SELECT n, reset_at FROM limits WHERE k = ?", args: [key] });
  if (!r.rows.length || Number(r.rows[0].reset_at) <= now) {
    await db().execute({
      sql: "INSERT INTO limits (k, n, reset_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = 1, reset_at = excluded.reset_at",
      args: [key, now + windowMs],
    });
    return true;
  }
  if (Number(r.rows[0].n) >= max) return false;
  await db().execute({ sql: "UPDATE limits SET n = n + 1 WHERE k = ?", args: [key] });
  return true;
}

export function requireJson(req, res) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) {
    res.status(415).json({ error: "JSON required" });
    return false;
  }
  return true;
}

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

export async function loadState(userId) {
  const r = await db().execute({ sql: "SELECT v, updated_at FROM state WHERE user_id = ?", args: [userId] });
  if (!r.rows.length) return { state: null, updatedAt: 0 };
  return { state: JSON.parse(r.rows[0].v), updatedAt: Number(r.rows[0].updated_at) };
}

export async function saveState(userId, state) {
  const now = Date.now();
  await db().execute({
    sql: "INSERT INTO state (user_id, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
    args: [userId, JSON.stringify(state), now],
  });
  return now;
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const bodyOf = (req) => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {});

export function entryAmt(state, e) {
  const p = (state.projects || []).find((x) => x.id === e.projectId);
  return e.billable && p ? Math.round(((e.secs / 3600) * (p.rate || 0)) * 100) / 100 : 0;
}
