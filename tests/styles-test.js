/* Статическая проверка: ни один элемент, который JS прячет через .hidden,
   не должен перекрываться авторским CSS-правилом display.
   Запуск: node tests/styles-test.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = read('index.html');
/* Комментарии убираем: иначе селектор правила «склеивается» с текстом
   комментария и перестаёт совпадать с классом элемента. */
const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const js = read('app.js');

/* id -> список классов элемента в HTML */
const byId = new Map();
for (const tag of html.matchAll(/<(\w+)([^>]*\sid="([^"]+)"[^>]*)>/g)) {
  const classes = [...tag[2].matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  byId.set(tag[3], { tag: tag[1], classes: classes.filter(Boolean) });
}

/* id -> элементы, на которые JS пишет .hidden */
const toggled = new Set();
for (const m of js.matchAll(/\$\('([^']+)'\)\.hidden\s*=/g)) toggled.add(m[1]);

/* селекторы авторских правил, задающих display */
const displayRules = [];
for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const body = m[2];
  if (!/(^|;|\s)display\s*:/.test(body)) continue;
  displayRules.push({ selector: m[1].trim(), hasImportant: /!important/.test(body) });
}

/* Ищем правило [hidden], которое объявляет display:none !important:
   !important побеждает любое не-важное авторское правило display,
   поэтому конфликты ниже оно снимает. */
const hiddenRule = [...css.matchAll(/\[hidden\]\s*\{([^}]*)\}/g)]
  .map((m) => m[1].trim())
  .find((body) => /display\s*:\s*none\s*!important/.test(body));

const hasOwnHiddenRule = !!hiddenRule;

console.log('элементов, скрываемых через .hidden:', toggled.size);
console.log('авторских правил с display:', displayRules.length);
console.log('глобальное правило [hidden]:', hasOwnHiddenRule ? 'есть' : 'НЕТ');
console.log('');

let problems = 0;

if (!hasOwnHiddenRule) {
  console.log('ПРОБЛЕМА: нет глобального [hidden] { display: none !important }');
  problems++;
}

for (const id of [...toggled].sort()) {
  const info = byId.get(id);
  if (!info) {
    console.log(`ПРОБЛЕМА: ${id} — нет такого элемента в index.html`);
    problems++;
    continue;
  }

  const conflicting = displayRules.filter((r) => {
    if (r.hasImportant) return false;
    return r.selector
      .split(',')
      .map((s) => s.trim())
      .some((sel) => {
        const cls = sel.match(/^\.([\w-]+)$/);
        return cls && info.classes.includes(cls[1]);
      });
  });

  if (conflicting.length) {
    if (hiddenRule) {
      console.log(`ok: ${id} (.${info.classes.join(' .')}) — перекрывается `
        + `${conflicting.map((c) => c.selector).join(', ')}, но снято [hidden] !important`);
    } else {
      console.log(`ПРОБЛЕМА: ${id} (<${info.tag}> .${info.classes.join(' .')}) `
        + `перекрывается: ${conflicting.map((c) => c.selector).join(', ')}`);
      problems++;
    }
  } else {
    console.log(`ok: ${id} — display не переопределён (${info.classes.join('.') || 'без классов'})`);
  }
}

/* парность вызовов: скрытие не должно забываться при закрытии */
const openAdds = /classList\.add\('panel-open'\)/.test(js);
const closeRemoves = /classList\.remove\('panel-open'\)/.test(js);
console.log('');
console.log('panel-open добавляется:', openAdds, '| снимается:', closeRemoves);
if (!openAdds || !closeRemoves) {
  console.log('ПРОБЛЕМА: класс panel-open не сбалансирован');
  problems++;
}

console.log(problems ? `\n${problems} проблем` : '\nПроблем не найдено');
process.exit(problems ? 1 : 0);
