/**
 * Запуск всех проверок: node tests/run.js
 *
 * Каждый набор сам возвращает ненулевой код при ошибке, но здесь они
 * идут подряд, чтобы одной командой увидеть весь итог сразу.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const suites = [
  { name: 'синтаксис', file: 'app.js', check: true },
  { name: 'синтаксис', file: 'sync.js', check: true },
  { name: 'синтаксис', file: 'worker/src/index.js', check: true },
  { name: 'приложение', file: 'tests/app-test.js' },
  { name: 'разметка', file: 'tests/markup-test.js' },
  { name: 'стили', file: 'tests/styles-test.js' },
  { name: 'сервер', file: 'tests/worker-test.mjs' },
];

const INTERESTING = /^(Проверок пройдено|Провалено|Все проверки|\d+ проверок провалено|Проблем)/;

let failed = 0;

for (const suite of suites) {
  /* --no-warnings идёт первым: node:sqlite пока считается экспериментальным
     и иначе печатает предупреждение, которое не относится к делу. */
  const args = ['--no-warnings', ...(suite.check ? ['--check'] : []), suite.file];
  const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const ok = run.status === 0;
  if (!ok) failed += 1;

  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const summary = output.split('\n').map((l) => l.trim()).filter((l) => INTERESTING.test(l));

  console.log(`${ok ? 'OK   ' : 'СБОЙ '} ${suite.name.padEnd(11)} ${suite.file}`);
  if (ok) {
    for (const line of summary) console.log(`       ${line}`);
  } else {
    for (const line of output.trim().split('\n')) console.log(`       ${line}`);
  }
}

console.log(failed ? `\nНаборов с ошибками: ${failed}` : '\nВсе наборы прошли');
process.exit(failed ? 1 : 0);
