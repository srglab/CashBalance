/**
 * Статическая проверка разметки против кода.
 *
 * Функциональные тесты гоняют приложение на стабах DOM, а стаб создаёт
 * любой недостающий элемент. Поэтому опечатка в id прошла бы их молча и
 * сломалась бы в настоящем браузере. Здесь id сверяются напрямую.
 *
 * Запуск: node tests/markup-test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const DIR = ROOT;

const html = read('index.html');
const css = read('styles.css');
const app = read('app.js');
const sync = read('sync.js');

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { passed += 1; return; }
  failures.push(name + (extra === undefined ? '' : ` → ${JSON.stringify(extra)}`));
}

/* ---------- что объявлено в разметке ---------- */

const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/* ---------- чем пользуется код ---------- */

const used = new Map();

function collect(source, file) {
  /* $('id') и getElementById('id') — единственные способы, которыми
     приложение достаёт элементы. */
  for (const m of source.matchAll(/(?:\$|getElementById)\(\s*'([^']+)'\s*\)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(file);
  }
}

collect(app, 'app.js');
collect(sync, 'sync.js');

const missing = [...used.keys()].filter((id) => !declared.has(id));
check('все элементы, которые ищет код, есть в разметке', missing.length === 0, missing);

/* ---------- на что ссылается разметка ---------- */

const refs = [
  ['aria-controls', /aria-controls="([^"]+)"/g],
  ['aria-labelledby', /aria-labelledby="([^"]+)"/g],
  ['aria-describedby', /aria-describedby="([^"]+)"/g],
  ['label for', /<label[^>]*\sfor="([^"]+)"/g],
];

for (const [name, pattern] of refs) {
  const bad = [...html.matchAll(pattern)].map((m) => m[1]).filter((id) => !declared.has(id));
  check(`${name} ссылается на существующие элементы`, bad.length === 0, bad);
}

/* ---------- подключённые файлы ---------- */

for (const m of html.matchAll(/<(?:script src|link[^>]*href)="([^"]+)"/g)) {
  const ref = m[1].replace(/^\.?\//, '');
  if (/^https?:/.test(ref)) continue;
  let ok = false;
  try { ok = fs.statSync(`${DIR}\\${ref}`).isFile(); } catch (err) { ok = false; }
  check(`файл ${ref} подключён и существует`, ok);
}

/* ---------- синхронизация не должна ломать офлайн ---------- */

check('sync.js подключён после app.js',
  html.indexOf('src="app.js"') < html.indexOf('src="sync.js"') && html.includes('src="sync.js"'));

/* Всё, что синхронизация трогает в разметке, обязано иметь обработчик
   или быть упомянутым в коде — иначе кнопка «мертвая». */
for (const id of ['syncBtn', 'syncDialog', 'syncUrl', 'syncPassword', 'syncConnect',
  'syncCancel', 'syncDisconnect', 'syncError', 'syncLabel', 'syncPassField', 'syncDialogText']) {
  check(`${id} есть в разметке и используется кодом`, declared.has(id) && used.has(id));
}

/* ---------- классы из разметки должны быть описаны ---------- */

const classesInHtml = new Set();
for (const m of html.matchAll(/\sclass="([^"]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) classesInHtml.add(c);
}

const unstyled = [...classesInHtml].filter((c) => !css.includes(`.${c}`));
check('все классы из разметки описаны в стилях', unstyled.length === 0, unstyled);

/* ---------- тёмная тема должна знать про новые элементы ---------- */

const darkBlock = css.slice(css.indexOf('prefers-color-scheme: dark'));
check('тёмная тема описана', darkBlock.length > 50);

/* ---------- ничего не уехало в CDN ---------- */

check('нет внешних скриптов', !/<script[^>]+src="https?:/.test(html));
check('нет внешних стилей', !/<link[^>]+href="https?:/.test(html));
check('нет модулей и fetch в index.html', !/type="module"|fetch\(/.test(html));

/* ---------- секретов в репозитории быть не должно ---------- */

const worker = read('worker/src/index.js');
const toml = read('wrangler.toml');

check('в Worker нет зашитого пароля',
  !/BUDGET_PASSWORD\s*[:=]\s*['"][^'"]{3,}/.test(worker));
check('в Worker нет зашитого секрета',
  !/SESSION_SECRET\s*[:=]\s*['"][^'"]{3,}/.test(worker));
check('пароль и секрет приходят из окружения',
  worker.includes('env.BUDGET_PASSWORD') && worker.includes('env.SESSION_SECRET'));
check('в wrangler.toml нет пароля', !/password|secret\s*=/i.test(toml.replace(/#.*/g, '')));
check('идентификатор базы остался заполнителем',
  toml.includes('ЗАПОЛНИТЕ_ПОСЛЕ_d1_create'));

/* ---------- итог ---------- */

console.log(`Проверок пройдено: ${passed}`);
if (failures.length) {
  console.log(`Провалено: ${failures.length}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('Провалено: 0');
}
