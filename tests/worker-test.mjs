/**
 * Тест Worker синхронизации.
 *
 * Worker прогоняется целиком: настоящий fetch(), настоящая подпись токена.
 * Вместо D1 используется обёртка над node:sqlite — это тот же SQLite,
 * поэтому проверяются реальные запросы, а не ощущение от кода.
 *
 * Требуется Node 22 или новее (нужен модуль node:sqlite).
 * Запуск: node --no-warnings tests/worker-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failures.push(name + (extra === undefined ? '' : ` → ${JSON.stringify(extra)}`));
}

/* ---------- окружение Worker ---------- */

const schema = fs.readFileSync(`${ROOT}/worker/schema.sql`, 'utf8');
const source = fs.readFileSync(`${ROOT}/worker/src/index.js`, 'utf8');

const worker = (await import(
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
)).default;

const db = new DatabaseSync(':memory:');
db.exec(schema);

/** Минимальная реализация того, что Worker ожидает от D1. */
function makeD1(handle) {
  const wrap = (sql, params) => ({
    bind: (...extra) => wrap(sql, params.concat(extra)),
    all: async () => ({ results: handle.prepare(sql).all(...params) }),
    first: async () => handle.prepare(sql).get(...params) ?? null,
    run: async () => { handle.prepare(sql).run(...params); return { success: true }; },
  });

  return {
    prepare: (sql) => wrap(sql, []),
    /* D1 выполняет пакет одной транзакцией — повторяем это поведение. */
    batch: async (statements) => {
      handle.exec('BEGIN');
      try {
        const out = [];
        for (const stmt of statements) out.push(await stmt.run());
        handle.exec('COMMIT');
        return out;
      } catch (err) {
        handle.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

const env = {
  DB: makeD1(db),
  BUDGET_PASSWORD: 'правильный-пароль',
  SESSION_SECRET: 'секрет-подписи-длинный-достаточный',
};

let token = '';

async function call(pathname, options = {}) {
  const { method = 'GET', body, raw, auth = true, headers = {} } = options;
  const all = { ...headers };

  if (body !== undefined || raw !== undefined) all['Content-Type'] = 'application/json';
  if (auth && token) all.Authorization = `Bearer ${token}`;

  const response = await worker.fetch(
    new Request(`https://worker.test${pathname}`, {
      method,
      headers: all,
      body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
    }),
    env,
  );

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  return { status: response.status, data, headers: response.headers };
}

function record(over = {}) {
  return {
    id: 'r1',
    type: 'expense',
    amount: 500,
    category: 'Еда',
    note: 'обед',
    start: '2026-09-01',
    repeat: 'none',
    repeatEvery: 1,
    weekdays: [],
    end: null,
    rev: 1,
    deleted: 0,
    ...over,
  };
}

/* ---------- 1. вход ---------- */

let r = await call('/api/login', { method: 'POST', body: { password: 'неверный' }, auth: false });
check('неверный пароль отклонён', r.status === 401, r.status);
check('в тексте ошибки нет самого пароля', !JSON.stringify(r.data).includes('неверный'), r.data);

r = await call('/api/login', { method: 'POST', body: { password: 'правильный-пароль' }, auth: false });
check('верный пароль принят', r.status === 200, r.status);
check('токен выдан', typeof r.data.token === 'string' && r.data.token.includes('.'), r.data);
check('срок действия в будущем', r.data.expiresAt > Date.now(), r.data.expiresAt);
token = r.data.token;

r = await call('/api/login', { method: 'POST', raw: '{это не json', auth: false });
check('битый JSON на входе не роняет Worker', r.status === 400, r.status);

r = await call('/api/login', { method: 'POST', body: {}, auth: false });
check('вход без пароля отклонён', r.status === 401, r.status);

r = await call('/api/login', { method: 'POST', body: { password: '' }, auth: false });
check('пустой пароль отклонён', r.status === 401, r.status);

/* ---------- 2. доступ ---------- */

r = await call('/api/changes', { auth: false });
check('без токена данные не отдаются', r.status === 401, r.status);

r = await call('/api/changes', { auth: false, headers: { Authorization: 'Bearer forged.forged' } });
check('подделанный токен отклонён', r.status === 401, r.status);

r = await call('/api/changes', { auth: false, headers: { Authorization: `Bearer.${Date.now() + 86400000}.abcdef` } });
check('токен с чужим сроком отклонён', r.status === 401, r.status);

r = await call('/api/changes', { auth: false, headers: { Authorization: token } });
check('токен без префикса Bearer отклонён', r.status === 401, r.status);

/* Подпись привязана к сроку: взяв токен и сдвинув срок, подделать нельзя. */
const [, realSig] = token.split('.');
r = await call('/api/changes', {
  auth: false,
  headers: { Authorization: `Bearer.${Date.now() + 86400000}.${realSig}` },
});
check('подпись не переносится на чужой срок', r.status === 401, r.status);

/* ---------- 3. предзапрос CORS ---------- */

r = await call('/api/changes', { method: 'OPTIONS', auth: false });
check('предзапрос без токена', r.status === 204, r.status);
check('разрешён источник', r.headers.get('Access-Control-Allow-Origin') === '*');
check('разрешён заголовок Authorization', (r.headers.get('Access-Control-Allow-Headers') || '').includes('Authorization'));

/* ---------- 4. пустое состояние ---------- */

r = await call('/api/changes?since=0');
check('пустая база отдаёт пустой список', r.data.changes.length === 0, r.data);
check('курсор пустой базы равен нулю', r.data.cursor === 0, r.data);
check('признак конца выдачи', r.data.hasMore === false, r.data);

r = await call('/api/changes?since=мусор');
check('битый курсор читается как ноль', r.status === 200 && r.data.cursor === 0, r.data);

/* ---------- 5. отправка и чтение ---------- */

r = await call('/api/changes', { method: 'POST', body: { records: [] } });
check('пустая отправка проходит', r.status === 200 && r.data.accepted === 0, r.data);

r = await call('/api/changes', { method: 'POST', body: { records: [record()] } });
check('новая запись принята', r.data.accepted === 1, r.data);
check('курсор сдвинулся', r.data.cursor > 0, r.data);

r = await call('/api/changes?since=0');
check('запись прочитана обратно', r.data.changes.length === 1, r.data);
const got = r.data.changes[0].record;
check('сумма сохранена', got.amount === 500, got);
check('назначение сохранено', got.note === 'обед', got);
check('счётчик изменений сохранён', got.rev === 1, got);

check('в состоянии одна строка', db.prepare('SELECT COUNT(*) AS n FROM tx').get().n === 1);
check('в журнале одна запись', db.prepare('SELECT COUNT(*) AS n FROM changes').get().n === 1);

/* ---------- 6. кто главнее по rev ---------- */

r = await call('/api/changes', { method: 'POST', body: { records: [record()] } });
check('тот же rev отвергается', r.data.accepted === 0 && r.data.rejected === 1, r.data);

r = await call('/api/changes', { method: 'POST', body: { records: [record({ rev: 5, amount: 900 })] } });
check('бо́льший rev принимается', r.data.accepted === 1, r.data);

r = await call('/api/changes?since=0');
const last = r.data.changes[r.data.changes.length - 1].record;
check('сервер хранит новую версию', last.amount === 900 && last.rev === 5, last);

r = await call('/api/changes', { method: 'POST', body: { records: [record({ rev: 3, amount: 1 })] } });
check('меньший rev отвергается', r.data.rejected === 1, r.data);

r = await call('/api/changes?since=0');
const stillLast = r.data.changes[r.data.changes.length - 1].record;
check('отвергнутая правка не испортила данные', stillLast.amount === 900, stillLast);

/* ---------- 7. мусор на входе ---------- */

const junk = [
  record({ id: 'bad-type', type: 'перевод' }),
  record({ id: 'bad-date', start: '01.09.2026' }),
  record({ id: 'bad-end', end: 'вчера' }),
  record({ id: 'bad-amount', amount: 'много' }),
  record({ id: 'bad-zero', amount: 0 }),
  record({ id: 'bad-neg', amount: -100 }),
  record({ id: 'bad-rev', rev: 0 }),
  record({ id: '', type: 'expense' }),
  record({ id: 'bad-repeat', repeat: 'ежегодно' }),
  record({ id: 'ok-alongside', amount: 100 }),
  null,
  'строка',
];

r = await call('/api/changes', { method: 'POST', body: { records: junk } });
check('из мусора уцелела одна запись', r.data.accepted === 1, r.data);

r = await call('/api/changes?since=0');
check('плохие записи не попали в базу', r.data.changes.every((c) => c.record.id !== 'bad-type'), r.data.changes.map((c) => c.record.id));
check('в базе только записи с допустимой суммой', r.data.changes.every((c) => c.record.amount > 0));

r = await call('/api/changes', { method: 'POST', body: { records: 'не список' } });
check('без списка records — отказ', r.status === 400, r.status);

r = await call('/api/changes', { method: 'POST', raw: 'не json вовсе' });
check('битое тело при отправке не роняет Worker', r.status === 400, r.status);

/* ---------- 8. чинение повторов ---------- */

r = await call('/api/changes', {
  method: 'POST',
  body: {
    records: [record({
      id: 'weekly-bad', repeat: 'weekly', weekdays: [], start: '2026-09-02',
    })],
  },
});
check('weekly без дней принят после починки', r.data.accepted === 1, r.data);

r = await call('/api/changes?since=0');
const weekly = r.data.changes.find((c) => c.record.id === 'weekly-bad').record;
check('дни недели подставлены от даты начала', JSON.stringify(weekly.weekdays) === '[3]', weekly.weekdays);

r = await call('/api/changes', {
  method: 'POST',
  body: { records: [record({ id: 'weekly-bad', rev: 2, repeat: 'weekly', weekdays: [7, 3, 3, 9, 0] })] },
});
r = await call('/api/changes?since=0');
const weekly2 = r.data.changes.filter((c) => c.record.id === 'weekly-bad').pop().record;
check('дни вычищены и отсортированы', JSON.stringify(weekly2.weekdays) === '[3,7]', weekly2.weekdays);

/* ---------- 9. удаление долетает до других устройств ---------- */

await call('/api/changes', {
  method: 'POST',
  body: { records: [record({ id: 'r2', amount: 700 }), record({ id: 'r3', amount: 800 })] },
});

const beforeDelete = await call('/api/changes?since=0');
const cursorB = beforeDelete.data.cursor;
const liveBefore = beforeDelete.data.changes.filter((c) => !c.record.deleted).length;
check('перед удалением записей достаточно', liveBefore >= 4, liveBefore);

r = await call('/api/changes', {
  method: 'POST',
  body: { records: [record({ id: 'r2', amount: 700, rev: 2, deleted: 1 })] },
});
check('удаление принято', r.data.accepted === 1, r.data);

r = await call(`/api/changes?since=${cursorB}`);
check('другое устройство видит только удаление', r.data.changes.length === 1, r.data.changes.length);
check('удаление помечено в журнале', r.data.changes[0].record.deleted === 1, r.data.changes[0]);
check('удаление несёт новый rev', r.data.changes[0].record.rev === 2, r.data.changes[0]);

check('удалённая запись убрана из состояния', db.prepare('SELECT deleted FROM tx WHERE id = ?').get('r2').deleted === 1);

/* ---------- 10. порядок и постраничная выдача ---------- */

await call('/api/changes', {
  method: 'POST',
  body: {
    records: Array.from({ length: 600 }, (_, i) => record({
      id: `bulk-${i}`, amount: 10 + i, rev: 1,
    })),
  },
});

const firstPage = await call('/api/changes?since=0');
check('страница ограничена 500 записями', firstPage.data.changes.length === 500, firstPage.data.changes.length);
check('признак продолжения выставлен', firstPage.data.hasMore === true);

const seqs = firstPage.data.changes.map((c) => c.seq);
check('порядок строго возрастает', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.slice(0, 5));

const secondPage = await call(`/api/changes?since=${firstPage.data.cursor}`);
check('вторая страница дочитывает остаток', secondPage.data.changes.length > 0 && secondPage.data.hasMore === false, secondPage.data.changes.length);

const thirdPage = await call(`/api/changes?since=${secondPage.data.cursor}`);
check('после конца выдачи пусто', thirdPage.data.changes.length === 0 && thirdPage.data.cursor === secondPage.data.cursor);

const total = firstPage.data.changes.length + secondPage.data.changes.length;
check('выдано ровно столько, сколько записано', total === db.prepare('SELECT COUNT(*) AS n FROM changes').get().n, total);

r = await call('/api/changes', {
  method: 'POST',
  body: { records: Array.from({ length: 1001 }, (_, i) => record({ id: `over-${i}` })) },
});
check('слишком большой пакет отклонён', r.status === 413, r.status);

/* ---------- 11. неизвестные адреса ---------- */

check('неизвестный путь — 404', (await call('/что-то')).status === 404);
check('ping отвечает с токеном', (await call('/api/ping')).data.ok === true);
check('ping методом POST — 404', (await call('/api/ping', { method: 'POST' })).status === 404);

/* ---------- 12. защита от подбора пароля ---------- */

/* Счётчик общий на адрес, поэтому проверяем его в самом конце. */
for (let i = 0; i < 12; i += 1) {
  await call('/api/login', { method: 'POST', body: { password: `попытка-${i}` }, auth: false });
}

r = await call('/api/login', { method: 'POST', body: { password: 'правильный-пароль' }, auth: false });
check('после серии неудач вход заблокирован', r.status === 429, r.status);

/* Уже выданный токен продолжает работать: пароль нужен только для входа. */
r = await call('/api/ping');
check('прежний токен не отзывается блокировкой', r.status === 200, r.status);

/* ---------- итог ---------- */

db.close();

console.log(`Проверок пройдено: ${passed}`);
if (failures.length) {
  console.log(`Провалено: ${failures.length}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('Провалено: 0');
}
