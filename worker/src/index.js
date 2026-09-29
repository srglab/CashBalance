/**
 * Worker синхронизации личного бюджета.
 *
 * Хранит операции в Cloudflare D1 и отдаёт их всем устройствам.
 * Данные не публичны: каждый запрос проверяется паролем,
 * который живёт в секрете Worker и никогда не попадает в репозиторий.
 *
 * Настройка:
 *   wrangler d1 create cashbalance            → вписать database_id в wrangler.toml
 *   wrangler d1 execute cashbalance --file=worker/schema.sql --remote
 *   wrangler secret put BUDGET_PASSWORD
 *   wrangler secret put SESSION_SECRET
 *   wrangler deploy
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const PULL_LIMIT = 500;

/* Сайт лежит на github.io, Worker — на workers.dev: это разные адреса,
   поэтому браузер шлёт предзапрос. Куки не используются, токен идёт
   в заголовке, так что происхождение можно принять любое. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const TYPES = new Set(['expense', 'income']);
const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- утилиты ---------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

const encoder = new TextEncoder();

function base64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

/* Сравнение за постоянное время: обычное === подсказывает длину
   правильного ответа по времени, этого хватает для перебора. */
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- пароль и токен ---------- */

async function passwordOk(env, given) {
  if (typeof given !== 'string' || !given) return false;
  return equalBytes(await sha256(given), await sha256(env.BUDGET_PASSWORD || ''));
}

async function mintToken(env) {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const key = await hmacKey(env.SESSION_SECRET || '');
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`budget.${expiry}`));
  return { token: `${expiry}.${base64url(sig)}`, expiresAt: expiry };
}

async function tokenValid(env, header) {
  if (typeof header !== 'string') return false;
  const [expiryText, sigText] = header.split('.');
  const expiry = Number(expiryText);
  if (!sigText || !Number.isFinite(expiry) || expiry < Date.now()) return false;

  const key = await hmacKey(env.SESSION_SECRET || '');
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(`budget.${expiry}`));
  return equalBytes(fromBase64url(sigText), new Uint8Array(expected));
}

function bearerOf(request) {
  const raw = request.headers.get('Authorization') || '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : null;
}

/* Защита от подбора пароля. Счётчик живёт в памяти изолята:
   это замедление перебора, а не полноценная защита — при сильной
   атаке помогает ещё и Cloudflare WAF или Cloudflare Access. */
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.since > ATTEMPT_WINDOW_MS) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.since > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, since: now });
  } else {
    entry.count += 1;
  }
}

/* ---------- проверка входящих данных ---------- */

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * Клиенту доверять нельзя: он мог быть подделан или просто содержать мусор.
 * Всё, что не прошло проверку, отбрасывается целиком.
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = str(raw.id, 64);
  const type = str(raw.type, 16);
  const repeat = str(raw.repeat, 16);
  const start = str(raw.start, 10);
  const amount = Number(raw.amount);
  const rev = Math.floor(Number(raw.rev));
  const end = raw.end == null ? null : str(raw.end, 10);

  if (!id || !TYPES.has(type) || !REPEATS.has(repeat)) return null;
  if (!ISO_DATE.test(start)) return null;
  if (end !== null && !ISO_DATE.test(end)) return null;
  /* Приложение отбрасывает неположительные суммы при чтении. Если сервер
     примет такую запись, она будет выпадать на каждом устройстве по-разному,
     поэтому не пускаем её дальше. */
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isFinite(rev) || rev < 1) return null;

  const weekdays = Array.isArray(raw.weekdays)
    ? [...new Set(raw.weekdays.map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
      .sort((a, b) => a - b)
    : [];

  return {
    id,
    type,
    amount,
    category: str(raw.category, 80),
    note: str(raw.note, 200),
    start,
    repeat,
    repeatEvery: Math.min(365, Math.max(1, Math.floor(Number(raw.repeatEvery)) || 1)),
    weekdays,
    end,
    rev,
    deleted: raw.deleted ? 1 : 0,
  };
}

/* Повтор weekly имеет смысл только со списком дней, иначе приложение
   подставит день начала. Не ошибаемся на данных, а чиним на лету. */
function repair(rec) {
  if (rec.repeat === 'weekly' && !rec.weekdays.length) {
    const dow = new Date(`${rec.start}T00:00:00Z`).getUTCDay() || 7;
    rec.weekdays = [dow];
  }
  return rec;
}

/* ---------- хранилище ---------- */

const UPSERT_TX = `
  INSERT INTO tx (id, type, amount, category, note, start, repeat, repeat_every,
                 weekdays, end_at, rev, deleted, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type, amount = excluded.amount, category = excluded.category,
    note = excluded.note, start = excluded.start, repeat = excluded.repeat,
    repeat_every = excluded.repeat_every, weekdays = excluded.weekdays,
    end_at = excluded.end_at, rev = excluded.rev, deleted = excluded.deleted,
    updated_at = excluded.updated_at`;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function maxSeq(env) {
  const row = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').first();
  return row ? Number(row.seq) : 0;
}

async function pushRecords(env, records) {
  const known = new Map();

  for (const chunk of chunks(records.map((r) => r.id), 50)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await env.DB
      .prepare(`SELECT id, rev FROM tx WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all();
    for (const row of rows.results) known.set(row.id, Number(row.rev));
  }

  /* Побеждает бо́льший rev. Поэтому устройство, у которого запись
     отстала, проигрывает и заберёт версию сервера при следующем pull. */
  const accepted = records.filter((r) => {
    const current = known.get(r.id);
    return current === undefined || r.rev > current;
  });

  if (accepted.length) {
    const now = Date.now();
    const statements = [];

    for (const rec of accepted) {
      statements.push(env.DB.prepare(UPSERT_TX).bind(
        rec.id, rec.type, rec.amount, rec.category, rec.note, rec.start,
        rec.repeat, rec.repeatEvery, JSON.stringify(rec.weekdays), rec.end,
        rec.rev, rec.deleted, now,
      ));
      statements.push(env.DB.prepare(
        'INSERT INTO changes (id, rev, deleted, data) VALUES (?, ?, ?, ?)',
      ).bind(rec.id, rec.rev, rec.deleted, JSON.stringify(publicRecord(rec))));
    }

    /* Всё одной транзакцией: журнал и состояние не могут разойтись. */
    await env.DB.batch(statements);
  }

  return {
    accepted: accepted.length,
    rejected: records.length - accepted.length,
    cursor: await maxSeq(env),
  };
}

function publicRecord(rec) {
  return {
    id: rec.id,
    type: rec.type,
    amount: rec.amount,
    category: rec.category,
    note: rec.note,
    start: rec.start,
    repeat: rec.repeat,
    repeatEvery: rec.repeatEvery,
    weekdays: rec.weekdays,
    end: rec.end,
    rev: rec.rev,
    deleted: rec.deleted,
  };
}

async function pullChanges(env, since) {
  const rows = await env.DB
    .prepare('SELECT seq, data FROM changes WHERE seq > ? ORDER BY seq LIMIT ?')
    .bind(since, PULL_LIMIT)
    .all();

  const list = rows.results;
  const cursor = list.length ? Number(list[list.length - 1].seq) : since;

  return {
    cursor,
    hasMore: list.length === PULL_LIMIT,
    changes: list.map((row) => {
      const data = JSON.parse(row.data);
      return { seq: Number(row.seq), record: data };
    }),
  };
}

/* ---------- маршруты ---------- */

async function handleLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (rateLimited(ip)) return fail('Слишком много попыток, попробуйте позже', 429);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail('Ожидался JSON');
  }

  if (!await passwordOk(env, body && body.password)) {
    noteFailure(ip);
    return fail('Неверный пароль', 401);
  }

  attempts.delete(ip);
  return json(await mintToken(env));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    if (!await tokenValid(env, bearerOf(request))) {
      return fail('Нужен вход: пароль неверен или истёк', 401);
    }

    if (url.pathname === '/api/ping' && request.method === 'GET') {
      return json({ ok: true });
    }

    if (url.pathname === '/api/changes' && request.method === 'GET') {
      const since = Number(url.searchParams.get('since'));
      return json(await pullChanges(env, Number.isFinite(since) && since > 0 ? since : 0));
    }

    if (url.pathname === '/api/changes' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return fail('Ожидался JSON');
      }

      if (!body || !Array.isArray(body.records)) return fail('Ожидался список records');
      if (body.records.length > 1000) return fail('Слишком много записей за раз', 413);

      const records = body.records.map(sanitize).filter(Boolean).map(repair);
      return json(await pushRecords(env, records));
    }

    return fail('Не найдено', 404);
  },
};
