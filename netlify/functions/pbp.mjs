// Page by Page: central release control.
//
//   GET  ?op=catalog   public   -> only the lessons and heart words the teacher has released (as of today)
//   POST ?op=load      teacher  -> the whole master copy (hidden things included)
//   POST ?op=save      teacher  -> replace the master copy (checks a revision number first)
//
// The teacher passcode is the TEACHER_PASSCODE environment variable (set it in Netlify, never in code).
// The master copy lives in Netlify Blobs under store "page-by-page", key "master".
// Dates are judged in the time zone PBP_TIMEZONE (default America/Chicago).

import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const TZ = () => process.env.PBP_TIMEZONE || "America/Chicago";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export function today(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function isVisible(x, day) {
  return !!x && (x.released === true || (DATE.test(x.releaseOn || "") && x.releaseOn <= day));
}
function sameSecret(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Checks and trims what the teacher sends. Returns null if it isn't a valid master copy. */
export function cleanMaster(body) {
  if (!body || !Array.isArray(body.lessons) || !Array.isArray(body.heartWords)) return null;
  if (body.lessons.length > 600 || body.heartWords.length > 3000) return null;
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const date = (v) => (DATE.test(String(v || "")) ? String(v) : "");
  const ids = new Set();
  const lessons = [];
  for (const l of body.lessons) {
    if (!l || typeof l !== "object" || !Array.isArray(l.pages) || !l.pages.length || l.pages.length > 500) return null;
    const id = str(l.id, 64);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    lessons.push({
      id,
      title: str(l.title, 200),
      lesson: str(l.lesson, 200),
      patterns: (Array.isArray(l.patterns) ? l.patterns : []).slice(0, 30).map((p) => str(p, 30)),
      pages: l.pages.map((p) => str(p, 1000)),
      released: l.released === true,
      releaseOn: date(l.releaseOn),
      createdAt: Number(l.createdAt) || 0,
    });
  }
  const seen = new Set();
  const heartWords = [];
  for (const h of body.heartWords) {
    if (!h || typeof h !== "object") return null;
    const w = str(h.w, 40).trim();
    const k = w.toLowerCase();
    if (!w || seen.has(k)) continue;
    seen.add(k);
    heartWords.push({ w, released: h.released === true, releaseOn: date(h.releaseOn) });
  }
  return { lessons, heartWords };
}

/** What students get: released things only, and no release settings at all. */
export function publicView(master, day) {
  return {
    rev: master.rev || 0,
    today: day,
    heartWords: (master.heartWords || []).filter((h) => isVisible(h, day)).map((h) => h.w),
    lessons: (master.lessons || [])
      .filter((l) => isVisible(l, day))
      .map((l) => ({ id: l.id, title: l.title, lesson: l.lesson, patterns: l.patterns, pages: l.pages, createdAt: l.createdAt, released: true })),
  };
}

export function makeHandler(openStore) {
  return async (req) => {
    try {
      const url = new URL(req.url);
      const op = url.searchParams.get("op") || "catalog";
      const store = openStore();
      const read = async () => (await store.get("master", { type: "json" })) || { rev: 0, lessons: [], heartWords: [] };

      if (op === "catalog" && req.method === "GET") {
        return json(publicView(await read(), today()), 200, {
          // browsers always ask the CDN; the CDN keeps a copy for a minute, so a whole class costs almost nothing
          "cache-control": "public, max-age=0, must-revalidate",
          "netlify-cdn-cache-control": "public, max-age=60, stale-while-revalidate=120",
        });
      }

      const pass = process.env.TEACHER_PASSCODE;
      if (!pass) return json({ error: "not_configured" }, 503);
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const key = req.headers.get("x-teacher-key") || "";
      if (!sameSecret(key, pass)) {
        if (key) await sleep(400); // slow down guessing; no delay when no passcode was sent yet
        return json({ error: "unauthorized" }, 401);
      }

      if (op === "load") return json(await read());

      if (op === "save") {
        let body;
        try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
        const clean = cleanMaster(body);
        if (!clean) return json({ error: "invalid" }, 400);
        const current = await read();
        if (Number(body.baseRev) !== (current.rev || 0)) return json({ error: "conflict", master: current }, 409);
        const next = { rev: (current.rev || 0) + 1, updated: new Date().toISOString(), ...clean };
        await store.setJSON("master", next);
        return json({ ok: true, rev: next.rev });
      }

      return json({ error: "unknown_op" }, 400);
    } catch (e) {
      console.error("pbp error", e);
      return json({ error: "server_error" }, 500);
    }
  };
}

export default makeHandler(() => getStore({ name: "page-by-page", consistency: "strong" }));
