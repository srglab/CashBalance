/* Функциональный тест приложения: календарь, повторения, накопленный итог,
   словарь назначений, напоминание о копии и синхронизация между устройствами.

   Приложение гоняется на стабах DOM в настоящем коде — то есть проверяется
   именно тот файл, который попадает на сайт.

   Запуск: node tests/app-test.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app.js');
const SYNC = path.join(ROOT, 'sync.js');

/* ---------- поддельный сервер синхронизации ---------- */

let serverHandler = null;
const requests = [];

global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (!serverHandler) throw new Error('сеть недоступна');
  return serverHandler(String(url), options);
};

/* Ответы настоящие, Response из Node — так проверяется разбор JSON. */
const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const sentRecords = () => {
  const post = requests.filter((r) => r.options && r.options.method === 'POST'
    && r.url.endsWith('/api/changes'));
  if (!post.length) return null;
  return JSON.parse(post[post.length - 1].options.body).records;
};

/* ---------- стабы браузера ---------- */

const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let confirmAnswer = true;
let confirmQuestion = null;

const nodes = new Map();

/* Разметка подсказок в стабе — обычная строка, и setAttribute на элемент
   её не меняет, поэтому выделение держим отдельно, по значению data-note. */
const itemSelected = new Map();

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function makeItem(note, selected) {
  return {
    dataset: { note },
    getAttribute: (a) => (a === 'aria-selected' ? String(selected) : null),
    setAttribute(a, v) { if (a === 'aria-selected') itemSelected.set(note, v); },
    scrollIntoView() {},
  };
}

function parseComboItems(html) {
  const re = /<li class="combo__item"[^>]*aria-selected="(true|false)"[^>]*data-note="([^"]*)"/g;
  const found = [];
  let m;
  while ((m = re.exec(html))) {
    const note = decode(m[2]);
    const selected = itemSelected.has(note) ? itemSelected.get(note) : m[1] === 'true';
    found.push(makeItem(note, selected));
  }
  return found;
}

function el(id) {
  const node = {
    id,
    value: '',
    textContent: '',
    hidden: false,
    files: [],
    handlers: {},
    attrs: {},
    classList: { add() {}, remove() {}, contains: () => false },
    /* Настоящий DOM игнорирует повторную регистрацию той же ссылки,
       а init() в тесте зовётся многократно — иначе обработчики копятся. */
    addEventListener(type, fn) {
      this.handlers[type] = this.handlers[type] || [];
      if (!this.handlers[type].includes(fn)) this.handlers[type].push(fn);
    },
    setAttribute(name, v) { this.attrs[name] = v; },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    append() {},
    focus() {},
    click() {},
    reset() {
      for (const id of ['amount', 'note', 'repeat', 'repeatEvery', 'untilDate', 'category', 'editId']) {
        if (nodes.has(id)) nodes.get(id).value = '';
      }
    },
    querySelectorAll(sel) {
      if (sel === '.combo__item') return parseComboItems(this.innerHTML);
      return [];
    },
    querySelector(sel) {
      if (sel === '.combo__item[aria-selected="true"]') {
        return parseComboItems(this.innerHTML)
          .find((i) => i.getAttribute('aria-selected') === 'true') || null;
      }
      return null;
    },
  };
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html || '',
    set: (v) => { node._html = String(v); itemSelected.clear(); },
  });
  nodes.set(id, node);
  return node;
}
const getEl = (id) => nodes.get(id) || el(id);

const radioState = { type: 'expense' };
function mkRadio(value) {
  const r = { value, addEventListener() {} };
  Object.defineProperty(r, 'checked', {
    get: () => radioState.type === value,
    set: (v) => { if (v) radioState.type = value; },
  });
  return r;
}
const radios = { expense: mkRadio('expense'), income: mkRadio('income') };

const bodyClasses = new Set();
const bodyClassList = {
  add: (...cs) => cs.forEach((c) => bodyClasses.add(c)),
  remove: (...cs) => cs.forEach((c) => bodyClasses.delete(c)),
  contains: (c) => bodyClasses.has(c),
  toggle: (c) => (bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c)),
};

const fakeDocument = {
  body: { classList: bodyClassList },
  addEventListener() {},
  getElementById: (id) => nodes.get(id) || el(id),
  createElement: () => ({ textContent: '', value: '', selected: false, href: '', download: '', click() {} }),
  querySelectorAll: (sel) => (sel === 'input[name="type"]' ? [radios.expense, radios.income] : []),
  querySelector: (sel) => {
    const m = sel.match(/value="([^"]+)"/);
    if (m && radios[m[1]]) return radios[m[1]];
    if (sel.includes(':checked')) return radios[radioState.type];
    if (sel === '#weekdayPicker input:checked' || sel === '#weekdayPicker input') return [];
    return el('stub');
  },
};

global.document = fakeDocument;
global.window = global;
global.localStorage = localStorage;
global.confirm = (q) => { confirmQuestion = q; return confirmAnswer; };
global.alert = () => {};
global.FileReader = class {
  readAsText() { this.onload(); }
};

/* ---------- загрузка приложения ---------- */

const api = ['state', 'init', 'openDay', 'closeDay', 'startEdit', 'removeTx', 'onSubmit',
  'monthIndex', 'monthTotals', 'matchingDaysInMonth', 'repeatLabel', 'load', 'toUTC',
  'fromUTC', 'isoDow', 'shiftMonth', 'daysInMonth', 'compact', 'normalizeAmount', 'plural',
  'carryInto', 'earliestMonth', 'rawMonthBalance', 'noteDictionary', 'noteSuggestions',
  'renderNoteSuggestions', 'closeNoteSuggestions', 'highlightNote', 'pickNote', 'onNoteKeyDown',
  'exportData', 'renderBackupNotice', 'lastExportAt', 'save', 'clearAll', 'Sync'];

/* sync.js положен рядом с app.js в том же скопе: он видит state и
   normalizeRecord, иначе проверять слияние было бы нечем. */
const wrapped = `${fs.readFileSync(APP, 'utf8')}\n${fs.readFileSync(SYNC, 'utf8')}`
  + `\n;globalThis.__api = { ${api.join(', ')} };`;
(0, eval)(wrapped);
const A = globalThis.__api;

/* ---------- assertions ---------- */

let failed = 0;
let passed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        получено: ${JSON.stringify(actual)} | ожидалось: ${JSON.stringify(expected)}`);
}

const fire = (id, type, event) => {
  for (const fn of getEl(id).handlers[type] || []) fn(event);
};
const submitForm = () => fire('txForm', 'submit', { preventDefault() {} });
const setType = (t) => { radioState.type = t; };

/* Пн–Вс: 1…7 */
const daysOfMonth = (month) => A.matchingDaysInMonth(
  { start: `${month}-01`, repeat: 'daily', repeatEvery: 1 }, month).map(A.fromUTC);

function addOn(iso, type, amount, category, note) {
  A.state.transactions.push({
    id: `t${A.state.transactions.length + 1}`,
    type,
    amount,
    category,
    note: note || '',
    start: iso,
    repeat: 'none',
    repeatEvery: 1,
    weekdays: [],
    end: null,
  });
}

/* ================= тесты ================= */

/* --- утилиты дат --- */
check('shiftMonth через границу года', A.shiftMonth('2026-01', -1), '2025-12');
check('shiftMonth вперёд через год', A.shiftMonth('2026-12', 1), '2027-01');
check('дней в феврале 2028 (високосный)', A.daysInMonth('2028-02'), 29);
check('дней в феврале 2026', A.daysInMonth('2026-02'), 28);
check('дней в апреле', A.daysInMonth('2026-04'), 30);
check('ISO-день недели: 2026-09-28 = пн', A.isoDow(A.toUTC('2026-09-28')), 1);
check('ISO-день недели: 2026-09-27 = вс', A.isoDow(A.toUTC('2026-09-27')), 7);
check('compact: 950', A.compact(950), '950');
check('compact: 1250', A.compact(1250), '1\u00a0250');
check('compact: 12500', A.compact(12500), '12,5\u00a0к');
check('compact: 90000', A.compact(90000), '90\u00a0к');
check('compact отрицательный', A.compact(-12500), '12,5\u00a0к');

/* --- повторения: ежедневно --- */
{
  const daily = { start: '2026-09-10', repeat: 'daily', repeatEvery: 1 };
  check('ежедневно: попадает в свой день', daysOfMonth('2026-09').includes('2026-09-10'), true);
  check('ежедневно: попадает в следующий день', daysOfMonth('2026-09').includes('2026-09-11'), true);
  check('ежедневно: 30 дней в сентябре', daysOfMonth('2026-09').length, 30);
  check('ежедневно: до старта пусто',
    A.matchingDaysInMonth({ start: '2026-10-01', repeat: 'daily' }, '2026-09').length, 0);
  check('ежедневно: продолжается в следующем месяце',
    daysOfMonth('2026-10').length, 31);
  check('ежемесячно: с 31-го не попадает в сентябрь (30 дней)',
    A.matchingDaysInMonth({ start: '2026-01-31', repeat: 'monthly' }, '2026-09').length, 0);
  check('каждые 3 дня',
    A.matchingDaysInMonth({ start: '2026-09-01', repeat: 'daily', repeatEvery: 3 }, '2026-09')
      .map(A.fromUTC).slice(0, 4),
    ['2026-09-01', '2026-09-04', '2026-09-07', '2026-09-10']);
  check('до ограничения датой',
    A.matchingDaysInMonth({ start: '2026-09-01', repeat: 'daily', end: '2026-09-05' }, '2026-09')
      .map(A.fromUTC),
    ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
  check('конец до начала даёт пусто',
    A.matchingDaysInMonth({ start: '2026-09-10', repeat: 'daily', end: '2026-09-01' }, '2026-09')
      .length, 0);
}

/* --- повторения: еженедельно --- */
{
  const weekly = { start: '2026-09-07', repeat: 'weekly', repeatEvery: 1 };
  check('еженедельно: понедельники',
    A.matchingDaysInMonth(weekly, '2026-09').map(A.fromUTC),
    ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  check('еженедельно: два дня в неделю (дни до старта не учитываются)',
    A.matchingDaysInMonth({ ...weekly, weekdays: [1, 4] }, '2026-09').map(A.fromUTC),
    ['2026-09-07', '2026-09-10', '2026-09-14', '2026-09-17', '2026-09-21', '2026-09-24', '2026-09-28']);
  check('еженедельно: каждые 2 недели',
    A.matchingDaysInMonth({ ...weekly, repeatEvery: 2 }, '2026-09').map(A.fromUTC),
    ['2026-09-07', '2026-09-21']);
  check('еженедельно: через месяц',
    A.matchingDaysInMonth(weekly, '2026-10').map(A.fromUTC),
    ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
}

/* --- повторения: ежемесячно --- */
{
  const rent = { start: '2026-01-05', repeat: 'monthly', repeatEvery: 1 };
  check('ежемесячно: 5-е число',
    A.matchingDaysInMonth(rent, '2026-09').map(A.fromUTC), ['2026-09-05']);
  check('ежемесячно: работает в прошлом месяце',
    A.matchingDaysInMonth(rent, '2026-02').map(A.fromUTC), ['2026-02-05']);
  check('ежемесячно: не работает до старта',
    A.matchingDaysInMonth({ start: '2026-03-05', repeat: 'monthly' }, '2026-02').length, 0);
  check('ежемесячно: каждые 3 месяца',
    A.matchingDaysInMonth({ start: '2026-01-10', repeat: 'monthly', repeatEvery: 3 }, '2026-01')
      .map(A.fromUTC), ['2026-01-10']);
  check('ежемесячно: 31-е пропускает короткие месяцы',
    A.matchingDaysInMonth({ start: '2026-01-31', repeat: 'monthly' }, '2026-02').length, 0);
  check('ежемесячно: 31-е работает в 31-дневном',
    A.matchingDaysInMonth({ start: '2026-01-31', repeat: 'monthly' }, '2026-03').map(A.fromUTC),
    ['2026-03-31']);
  check('одноразовая операция не размножается',
    A.matchingDaysInMonth({ start: '2026-09-15', repeat: 'none' }, '2026-09').map(A.fromUTC),
    ['2026-09-15']);
  check('одноразовая в другом месяце пусто',
    A.matchingDaysInMonth({ start: '2026-09-15', repeat: 'none' }, '2026-10').length, 0);
}

/* --- подписи повторений --- */
check('подпись: не повторять', A.repeatLabel({ start: '2026-09-01', repeat: 'none' }), null);
check('подпись: ежедневно',
  A.repeatLabel({ start: '2026-09-01', repeat: 'daily', repeatEvery: 1 }), 'каждый день');
check('подпись: каждые 3 дня',
  A.repeatLabel({ start: '2026-09-01', repeat: 'daily', repeatEvery: 3 }), 'каждые 3 дня');
check('подпись: каждые 5 дней',
  A.repeatLabel({ start: '2026-09-01', repeat: 'daily', repeatEvery: 5 }), 'каждые 5 дней');
check('подпись: еженедельно с днями',
  A.repeatLabel({ start: '2026-09-07', repeat: 'weekly', repeatEvery: 1, weekdays: [1, 3] }),
  'еженедельно: Пн, Ср');
check('подпись: каждые 2 недели',
  A.repeatLabel({ start: '2026-09-07', repeat: 'weekly', repeatEvery: 2, weekdays: [1] }),
  'каждые 2 недели: Пн');
check('подпись: ежемесячно',
  A.repeatLabel({ start: '2026-09-05', repeat: 'monthly', repeatEvery: 1 }),
  'ежемесячно, 5-го числа');
check('подпись: с датой окончания',
  A.repeatLabel({ start: '2026-09-05', repeat: 'monthly', end: '2026-12-31' }),
  'ежемесячно, 5-го числа до 31 дек.');

/* --- полный цикл приложения --- */
store.clear();
A.init();
check('старт: операций нет', A.state.transactions.length, 0);
check('старт: пустой календарь рисуется', getEl('calendar').innerHTML.includes('class="day'), true);
check('старт: число плиток кратно 7',
  (getEl('calendar').innerHTML.match(/class="day(?:"| )/g) || []).length % 7, 0);
check('старт: плиток ровно столько же, сколько дней в месяце',
  (getEl('calendar').innerHTML.match(/class="day(?:"| )/g) || []).length
    - (getEl('calendar').innerHTML.match(/day--out/g) || []).length,
  A.daysInMonth(A.state.month));
check('старт: в каждой плитке три числа', (() => {
  const first = getEl('calendar').innerHTML.split('</button>')[0];
  return (first.match(/class="day__val /g) || []).length;
})(), 3);

A.state.month = '2026-09';
A.openDay('2026-09-15');
check('день открыт', A.state.selected, '2026-09-15');
check('панель показана', getEl('dayPanel').hidden, false);
check('заголовок панели содержит дату', getEl('dayTitle').textContent.length > 10, true);

/* добавляем разовый расход */
setType('expense');
getEl('amount').value = '500';
getEl('category').value = 'Продукты';
getEl('note').value = 'хлеб';
submitForm();
check('разовая операция добавлена', A.state.transactions.length, 1);
check('разовая попала в плитку дня', A.monthTotals('2026-09').expense, 500);
check('панель показывает операцию', getEl('dayList').innerHTML.includes('хлеб'), true);
check('подпись повтора не показана', getEl('dayList').innerHTML.includes('↻'), false);

/* добавляем ежемесячную аренду */
A.openDay('2026-09-05');
setType('expense');
getEl('amount').value = '45000';
getEl('category').value = 'Жильё и коммуналка';
getEl('repeat').value = 'monthly';
fire('repeat', 'change');
check('поле «каждые N» показано', getEl('everyField').hidden, false);
check('подпись единицы: месяцев', getEl('everyHelp').textContent, 'месяцев');
submitForm();
check('повторяющаяся операция добавлена', A.state.transactions.length, 2);
check('аренда повторяется в октябре', A.monthTotals('2026-10').expense, 45000);
check('аренда не появилась в августе', A.monthTotals('2026-08').expense, 0);
check('в сентябре аренда учтена один раз', A.monthTotals('2026-09').expense, 45500);
check('плитка помечена как повторяющаяся',
  getEl('calendar').innerHTML.includes('day__replay'), true);

/* ежедневный кофе */
A.openDay('2026-09-01');
setType('expense');
getEl('amount').value = '300';
getEl('category').value = 'Продукты';
getEl('repeat').value = 'daily';
fire('repeat', 'change');
check('подпись единицы: дней', getEl('everyHelp').textContent, 'дней');
submitForm();
check('ежедневная операция учтена во всех днях месяца',
  A.monthTotals('2026-09').expense, 45500 + 300 * 30);
check('ежедневная работает в следующем месяце',
  A.monthTotals('2026-10').expense, 45000 + 300 * 31);

/* итоги по категориям учитывают повторы */
check('разбивка: аренда присутствует', getEl('breakdown').innerHTML.includes('Жильё и коммуналка'), true);
check('разбивка: сортировка по убыванию (аренда 45 000 > продукты 9 500)',
  getEl('breakdown').innerHTML.indexOf('Жильё и коммуналка')
  < getEl('breakdown').innerHTML.indexOf('Продукты'), true);

/* баланс плитки */
A.openDay('2026-09-15');
check('итоги дня: расход', getEl('dayExpense').textContent, 'расход 800\u00a0₽');
check('итоги дня: баланс', getEl('dayBalance').textContent, 'за день −800\u00a0₽');
/* на 15-е накоплено: кофе 300×15 + аренда 45 000 (5-го) + продукты 500 (15-го) = 50 000 */
check('итоги дня: накопленный итог', getEl('dayCumulative').textContent,
  'накопленным −50\u00a0000\u00a0₽');
check('список дня: две операции',
  (getEl('dayList').innerHTML.match(/class="item"/g) || []).length, 2);
check('список дня: есть метка повтора', getEl('dayList').innerHTML.includes('↻'), true);

/* редактирование повторяющейся операции меняет все повторения */
const rentId = A.state.transactions.find((t) => t.repeat === 'monthly').id;
A.startEdit(rentId);
check('форма правки: подсказка видна', getEl('formHint').hidden, false);
check('форма правки: подсказка упоминает повтор',
  getEl('formHint').textContent.includes('ежемесячно'), true);
getEl('amount').value = '50000';
submitForm();
check('сумма повтора обновлена', A.monthTotals('2026-09').expense, 45500 - 45000 + 50000 + 9000);
check('изменение применилось к будущим месяцам',
  A.monthTotals('2026-11').expense, 50000 + 300 * 30);

/* отмена правки */
A.startEdit(rentId);
getEl('amount').value = '1';
fire('cancelBtn', 'click');
check('отмена сбрасывает сумму', getEl('amount').value, '');
check('отмена возвращает кнопку', getEl('submitBtn').textContent, 'Добавить');
check('отмена не меняет данные', A.monthTotals('2026-11').expense, 50000 + 300 * 30);

/* валидация */
A.openDay('2026-09-20');
getEl('amount').value = '0';
submitForm();
check('нулевая сумма отклонена', A.state.transactions.length, 3);
getEl('amount').value = '-100';
submitForm();
check('отрицательная сумма отклонена', A.state.transactions.length, 3);
getEl('amount').value = '100';
getEl('repeat').value = 'daily';
getEl('untilDate').value = '2026-09-01';
submitForm();
check('дата окончания раньше старта отклонена', A.state.transactions.length, 3);

/* недельное повторение через интерфейс */
A.openDay('2026-09-07');
setType('expense');
getEl('amount').value = '200';
getEl('category').value = 'Транспорт';
getEl('repeat').value = 'weekly';
getEl('repeatEvery').value = '1';
fire('repeat', 'change');
check('выбор дней недели показан', getEl('weekdaysField').hidden, false);
submitForm();
check('недельная операция добавлена', A.state.transactions.length, 4);
const weeklyTx = A.state.transactions.find((t) => t.repeat === 'weekly');
check('день недели взят из даты старта', weeklyTx.weekdays, [1]);

/* удаление */
confirmAnswer = true;
const rentCountBefore = A.monthTotals('2026-10').expense;
A.removeTx(rentId);
check('повтор удалён', A.state.transactions.length, 3);
check('повтор исчез из будущих месяцев',
  A.monthTotals('2026-10').expense, rentCountBefore - 50000);
check('вопрос подтверждал удаление всех повторов',
  confirmQuestion.includes('все её повторения'), true);

/* закрытие панели */
A.closeDay();
check('панель закрыта', A.state.selected, null);
check('панель скрыта в DOM', getEl('dayPanel').hidden, true);
check('затемнение скрыто', getEl('backdrop').hidden, true);
check('класс panel-open снят', bodyClasses.has('panel-open'), false);
check('после закрытия форма сброшена', getEl('submitBtn').textContent, 'Добавить');

A.openDay('2026-09-15');
check('при открытии класс panel-open выставлен', bodyClasses.has('panel-open'), true);
A.closeDay();

/* смена месяца, когда открыт день из другого месяца */
A.state.month = '2026-09';
A.openDay('2026-09-15');
fire('nextMonth', 'click');
check('класс panel-open снят при уходе на другой месяц', bodyClasses.has('panel-open'), false);
check('панель закрыта при уходе на другой месяц', getEl('dayPanel').hidden, true);
fire('prevMonth', 'click');

/* переключение между плитками без переоткрытия панели */
A.state.month = '2026-09';
A.openDay('2026-09-10');
const panelBefore = getEl('dayPanel').hidden;
const titleBefore = getEl('dayTitle').textContent;
A.openDay('2026-09-12');
check('панель не скрывалась при переключении дня', getEl('dayPanel').hidden, panelBefore);
check('выбран новый день', A.state.selected, '2026-09-12');
check('заголовок панели обновился', getEl('dayTitle').textContent !== titleBefore, true);
check('затемнение не переоткрывалось', getEl('backdrop').hidden, false);
A.openDay('2026-09-10');
check('возврат назад работает так же', A.state.selected, '2026-09-10');
A.closeDay();

/* навигация по месяцам */
fire('nextMonth', 'click');
check('месяц вперёд', A.state.month, '2026-10');
check('после перехода месяц в заголовке',
  getEl('monthTitle').textContent.length > 3, true);
fire('prevMonth', 'click');
check('месяц назад', A.state.month, '2026-09');

/* сохранение и загрузка */
check('операции сохранены', JSON.parse(store.get('pb.transactions.v2')).length, 3);
A.init();
check('повторы пережили перезагрузку',
  A.state.transactions.filter((t) => t.repeat === 'daily').length, 1);
check('после перезагрузки итоги те же', A.monthTotals('2026-10').expense,
  300 * 31 + 200 * 4);

/* миграция со старой версии (поле date) */
store.set('pb.transactions.v2', JSON.stringify([
  { type: 'expense', amount: 100, date: '2026-09-03', category: 'Прочее' },
  { id: 'x', type: 'income', amount: '2500', date: '2026-09-03', category: 'Зарплата' },
]));
A.init();
check('старые данные загружены', A.state.transactions.length, 2);
check('старое поле date стало start', A.state.transactions[0].start, '2026-09-03');
check('повтор по умолчанию — нет', A.state.transactions[0].repeat, 'none');
check('старая сумма стала числом', A.state.transactions[1].amount, 2500);
check('итоги миграции', A.monthTotals('2026-09').expense, 100);

/* устойчивость к мусору */
store.set('pb.transactions.v2', '[{"type":"expense","amount":-5,"date":"2026-09-01"},'
  + '{"type":"expense","amount":"abc","date":"2026-09-01"},null,'
  + '{"type":"income","amount":10,"start":"2026-09-02","repeat":"weekly","weekdays":[9,0]},'
  + '{"type":"expense","amount":10,"start":"2026-09-02","repeat":"monthly","repeatEvery":0}]');
A.init();
check('отрицательная сумма отброшена', A.state.transactions.length, 2);
check('некорректный день недели отброшен',
  A.state.transactions.find((t) => t.repeat === 'weekly').weekdays, []);
check('repeatEvery нормализован в 1',
  A.state.transactions.find((t) => t.repeat === 'monthly').repeatEvery, 1);

store.set('pb.transactions.v2', '{{{ сломанный json');
check('битый JSON не ломает приложение', A.load().length, 0);
check('после битого JSON приложение работает', A.init(), undefined);
check('календарь всё равно отрисован', getEl('calendar').innerHTML.includes('class="day'), true);

/* ================= накопленный баланс ================= */

/* Чистый набор: приход в начале июля, расходы в июле и сентябре. */
const records = [
  { id: 'a', type: 'income', amount: 1000, category: 'Зарплата', note: '',
    start: '2026-07-01', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'b', type: 'expense', amount: 100, category: 'Прочее', note: '',
    start: '2026-07-02', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'c', type: 'expense', amount: 200, category: 'Прочее', note: '',
    start: '2026-09-05', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
];
store.set('pb.transactions.v2', JSON.stringify(records));
A.init();

check('ранний месяц с данными', A.earliestMonth(), '2026-07');
check('баланс июля: 1000 − 100', A.rawMonthBalance('2026-07'), 900);
check('баланс августа: движений нет', A.rawMonthBalance('2026-08'), 0);
check('баланс сентября: −200', A.rawMonthBalance('2026-09'), -200);

check('на 1-е июля ещё ничего нет', A.carryInto('2026-07'), 0);
check('на 1-е августа накоплено 900', A.carryInto('2026-08'), 900);
check('на 1-е сентября накоплено 900', A.carryInto('2026-09'), 900);
check('на 1-е октября накоплено 700', A.carryInto('2026-10'), 700);
check('месяц раньше первых данных — ноль', A.carryInto('2026-01'), 0);

{
  const jul = A.monthIndex('2026-07');
  check('1 июля накопленный 1000', jul.get('2026-07-01').cumulative, 1000);
  check('2 июля накопленный 900', jul.get('2026-07-02').cumulative, 900);
  check('3 июля накопленный 900', jul.get('2026-07-03').cumulative, 900);
  check('31 июля накопленный 900', jul.get('2026-07-31').cumulative, 900);
  check('баланс дня отдельно остаётся 1000', jul.get('2026-07-01').balance, 1000);
  check('баланс 2-го дня отдельно −100', jul.get('2026-07-02').balance, -100);
}
{
  const aug = A.monthIndex('2026-08');
  check('август начинается с 900', aug.get('2026-08-01').cumulative, 900);
  check('31 августа накопленный 900', aug.get('2026-08-31').cumulative, 900);
}
{
  const sep = A.monthIndex('2026-09');
  check('1 сентября накопленный 900', sep.get('2026-09-01').cumulative, 900);
  check('4 сентября ещё 900', sep.get('2026-09-04').cumulative, 900);
  check('5 сентября 700', sep.get('2026-09-05').cumulative, 700);
  check('30 сентября 700', sep.get('2026-09-30').cumulative, 700);
}

check('накопленный итог = сумма месячных балансов',
  A.carryInto('2026-10'),
  A.rawMonthBalance('2026-07') + A.rawMonthBalance('2026-08') + A.rawMonthBalance('2026-09'));

/* повтор должен попадать в накопленный итог */
records.push(
  { id: 'd', type: 'expense', amount: 50, category: 'Прочее', note: '',
    start: '2026-09-01', repeat: 'daily', repeatEvery: 1, weekdays: [], end: null });
store.set('pb.transactions.v2', JSON.stringify(records));
A.init();
check('ежедневный расход учтён в накопленном итоге',
  A.monthIndex('2026-09').get('2026-09-30').cumulative, 700 - 50 * 30);
check('баланс месяца не изменился под накопленным итогом',
  A.monthTotals('2026-09').balance, -200 - 50 * 30);

/* кеш должен сбрасываться при изменении данных:
   900 (июль) + 0 (август) − 200 − 1500 (сентябрь) */
check('кеш накопленного сброшен после загрузки',
  A.carryInto('2026-10'), 900 - 200 - 50 * 30);

/* ================= словарь назначений ================= */

const noteRecords = [
  { id: 'n1', type: 'expense', amount: 300, category: 'Продукты', note: 'Кофе', start: '2026-09-01', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n2', type: 'expense', amount: 300, category: 'Продукты', note: 'Кофе', start: '2026-09-02', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n3', type: 'expense', amount: 300, category: 'Продукты', note: 'Кофе', start: '2026-09-03', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n4', type: 'expense', amount: 500, category: 'Продукты', note: 'Обед', start: '2026-09-04', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n5', type: 'income', amount: 90000, category: 'Зарплата', note: 'Зарплата', start: '2026-09-01', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n6', type: 'income', amount: 5000, category: 'Перевод', note: 'Перевод на карту', start: '2026-09-02', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n7', type: 'income', amount: 5000, category: 'Перевод', note: 'Перевод на карту', start: '2026-09-03', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n8', type: 'expense', amount: 100, category: 'Прочее', note: '   ', start: '2026-09-05', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
  { id: 'n9', type: 'expense', amount: 200, category: 'Прочее', note: '', start: '2026-09-06', repeat: 'none', repeatEvery: 1, weekdays: [], end: null },
];
store.set('pb.transactions.v2', JSON.stringify(noteRecords));
A.init();
setType('expense');

check('словарь: пустые назначения не попадают', A.noteDictionary().length, 4);
check('словарь: самые частые первыми', A.noteDictionary()[0].note, 'Кофе');
check('словарь: количество использований', A.noteDictionary()[0].count, 3);
check('словарь: перевод использован дважды',
  A.noteDictionary().find((e) => e.note === 'Перевод на карту').count, 2);
check('словарь: помнит типы операции',
  [...A.noteDictionary().find((e) => e.note === 'Кофе').types], ['expense']);

/* порядок: сначала назначения того же типа, потом остальные */
getEl('note').value = '';
check('подсказки: свой тип вперёд, даже при меньшем счётчике',
  A.noteSuggestions().map((e) => e.note), ['Кофе', 'Обед', 'Перевод на карту', 'Зарплата']);

setType('income');
check('подсказки: для дохода свой тип вперёд',
  A.noteSuggestions().map((e) => e.note), ['Перевод на карту', 'Зарплата', 'Кофе', 'Обед']);
setType('expense');

/* фильтр по подстроке, без учёта регистра */
getEl('note').value = 'коф';
check('подсказки: поиск без учёта регистра', A.noteSuggestions().map((e) => e.note), ['Кофе']);
getEl('note').value = 'РЕ';
check('подсказки: поиск в верхнем регистре', A.noteSuggestions().map((e) => e.note), ['Перевод на карту']);
getEl('note').value = 'ещ';
check('подсказки: ничего не найдено', A.noteSuggestions().length, 0);

/* отрисовка списка */
getEl('note').value = '';
A.renderNoteSuggestions();
check('список подсказок показан', getEl('noteList').hidden, false);
check('поле помечено как раскрытое', getEl('note').getAttribute('aria-expanded'), 'true');
check('в списке все четыре варианта', getEl('noteList').querySelectorAll('.combo__item').length, 4);
check('у подсказки есть счётчик', getEl('noteList').innerHTML.includes('3 раза'), true);

/* пустой результат закрывает список */
getEl('note').value = 'ещ';
A.renderNoteSuggestions();
check('пустой результат закрывает список', getEl('noteList').hidden, true);
check('поле помечено как закрытое', getEl('note').getAttribute('aria-expanded'), 'false');

/* клавиатура */
getEl('note').value = '';
A.renderNoteSuggestions();

const keyEvent = (key) => ({
  key,
  defaultPrevented: false,
  stopped: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.stopped = true; },
});

let ev = keyEvent('ArrowDown');
fire('note', 'keydown', ev);
check('стрелка вниз выделяет первую подсказку', ev.defaultPrevented, true);
check('выделен «Кофе»',
  getEl('noteList').querySelector('.combo__item[aria-selected="true"]').dataset.note, 'Кофе');

ev = keyEvent('ArrowDown');
fire('note', 'keydown', ev);
check('вторая подсказка выделена',
  getEl('noteList').querySelector('.combo__item[aria-selected="true"]').dataset.note, 'Обед');

ev = keyEvent('ArrowUp');
fire('note', 'keydown', ev);
check('стрелка вверх возвращает к первой',
  getEl('noteList').querySelector('.combo__item[aria-selected="true"]').dataset.note, 'Кофе');

ev = keyEvent('ArrowUp');
fire('note', 'keydown', ev);
check('стрелка вверх зацикливается на последней',
  getEl('noteList').querySelector('.combo__item[aria-selected="true"]').dataset.note, 'Зарплата');

ev = keyEvent('Enter');
fire('note', 'keydown', ev);
check('Enter выбирает выделенное', getEl('note').value, 'Зарплата');
check('Enter не отправляет форму', ev.defaultPrevented, true);
check('после выбора список закрыт', getEl('noteList').hidden, true);

/* Enter без выделения должен отправить форму */
getEl('note').value = 'ко';
A.renderNoteSuggestions();
ev = keyEvent('Enter');
fire('note', 'keydown', ev);
check('Enter без выделения не перехватывается', ev.defaultPrevented, false);

/* Esc закрывает подсказки, но не панель дня */
getEl('note').value = '';
A.renderNoteSuggestions();
ev = keyEvent('Escape');
fire('note', 'keydown', ev);
check('Esc закрыл список подсказок', getEl('noteList').hidden, true);
check('Esc не дошёл до обработчика панели', ev.stopped, true);

/* Esc при закрытых подсказках не перехватывается */
ev = keyEvent('Escape');
fire('note', 'keydown', ev);
check('Esc при закрытом списке не перехватывается', ev.stopped, false);

/* клик мышью по подсказке */
getEl('note').value = '';
A.renderNoteSuggestions();
getEl('noteList').querySelectorAll('.combo__item');
fire('noteList', 'click', { target: { closest: () => ({ dataset: { note: 'Обед' } }) } });
check('клик по подсказке подставляет значение', getEl('note').value, 'Обед');
check('после клика список закрыт', getEl('noteList').hidden, true);

/* ограничение длины списка */
store.set('pb.transactions.v2', JSON.stringify(
  Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`, type: 'expense', amount: 10, category: 'Прочее',
    note: `Покупка ${i}`, start: '2026-09-01', repeat: 'none', repeatEvery: 1, weekdays: [], end: null,
  }))));
A.init();
getEl('note').value = '';
A.renderNoteSuggestions();
check('список подсказок ограничен 12 строками',
  getEl('noteList').querySelectorAll('.combo__item').length, 12);

/* подсказка в поле правки */
store.set('pb.transactions.v2', JSON.stringify(noteRecords));
A.init();
A.openDay('2026-09-01');
A.startEdit('n1');
check('правка подставляет назначение', getEl('note').value, 'Кофе');

/* подпись под полем */
check('подпись показывает размер словаря',
  getEl('noteHelp').textContent, 'Подсказки из 4 прошлых записей');
store.set('pb.transactions.v2', '[]');
A.init();
check('на пустом словаре подпись другая',
  getEl('noteHelp').textContent, 'Подсказки появятся после первой записи с назначением');
check('на пустом словаре подсказок нет', A.noteSuggestions().length, 0);

/* назначение, введённое вручную, само попадает в словарь */
A.openDay('2026-09-10');
getEl('amount').value = '250';
getEl('note').value = 'Такси';
submitForm();
check('новое назначение попало в словарь',
  A.noteDictionary().some((e) => e.note === 'Такси'), true);
check('новое назначение предлагается в подсказках',
  A.noteSuggestions().some((e) => e.note === 'Такси'), true);
check('после сохранения список подсказок закрыт', getEl('noteList').hidden, true);
check('форма очищена после сохранения', getEl('note').value, '');
check('подсказка предлагается по части слова',
  (() => { getEl('note').value = 'такс'; return A.noteSuggestions().map((e) => e.note); })(), ['Такси']);
check('после сброса формы словарь не потерян',
  A.noteDictionary().some((e) => e.note === 'Такси'), true);

/* ================= напоминание о резервной копии ================= */

const stamp = () => store.get('pb.lastExport');
const noticeText = () => getEl('backupNoticeText').textContent;
const noticeShown = () => getEl('backupNotice').hidden === false;

const someOps = [{ id: 'b1', type: 'expense', amount: 100, category: 'Прочее', note: '',
  start: '2026-09-01', repeat: 'none', repeatEvery: 1, weekdays: [], end: null }];

/* без отметки о копии напоминание показано */
store.delete('pb.lastExport');
store.set('pb.transactions.v2', JSON.stringify(someOps));
A.init();
check('без копии напоминание показано', noticeShown(), true);
check('текст предлагает выгрузить', noticeText().includes('стоит выгрузить'), true);

/* пустой учёт не беспокоит */
store.set('pb.transactions.v2', '[]');
A.init();
check('на пустом учёте напоминания нет', noticeShown(), false);

/* свежая копия — напоминания нет */
store.set('pb.transactions.v2', JSON.stringify(someOps));
store.set('pb.lastExport', String(Date.now() - 5 * 86400000));
A.init();
check('после свежей копии напоминания нет', noticeShown(), false);

/* копии нет 40 дней — напоминание есть */
store.set('pb.lastExport', String(Date.now() - 40 * 86400000));
A.init();
check('через 40 дней напоминание вернулось', noticeShown(), true);
check('в тексте указано число дней', noticeText().includes('40 дней'), true);

/* ровно 29 дней — ещё тихо */
store.set('pb.lastExport', String(Date.now() - 29 * 86400000));
A.init();
check('на 29-й день напоминания нет', noticeShown(), false);

/* экспорт снимает напоминание и ставит отметку */
store.set('pb.lastExport', String(Date.now() - 40 * 86400000));
A.init();
check('до экспорта напоминание было', noticeShown(), true);
const before = stamp();
A.exportData();
check('экспорт проставил свежую отметку', Number(stamp()) > Number(before), true);
check('после экспорта напоминание скрыто', noticeShown(), false);

/* граница ровно в 30 дней: показываем */
store.set('pb.lastExport', String(Date.now() - 30 * 86400000 - 60000));
A.init();
check('на 30-й день показываем', noticeShown(), true);

/* ---------- синхронизация между устройствами ---------- */

const PASSWORD = 'секретный';
const HOST = 'https://budget.workers.dev';

/* Маленький сервер в памяти: повторяет правила настоящего Worker,
   чтобы клиентские проверки шли против сервера, а не против заглушки. */
function fakeServer(options = {}) {
  const records = new Map();
  const journal = [];
  let seq = 0;

  serverHandler = async (url, opts = {}) => {
    if (url.endsWith('/api/login')) {
      const body = JSON.parse(opts.body);
      if (body.password !== PASSWORD) return reply({ error: 'Неверный пароль' }, 401);
      return reply({ token: '1000.abcdef', expiresAt: Date.now() + 86400000 });
    }

    if (url.includes('/api/changes') && opts.method === 'POST') {
      const incoming = JSON.parse(opts.body).records;
      let accepted = 0;
      for (const rec of incoming) {
        const cur = records.get(rec.id);
        if (cur && rec.rev <= cur.rev) continue;
        records.set(rec.id, rec);
        journal.push({ seq: (seq += 1), record: rec });
        accepted += 1;
      }
      return reply({ accepted, rejected: incoming.length - accepted, cursor: seq });
    }

    if (url.includes('/api/changes')) {
      const since = Number(new URL(url).searchParams.get('since')) || 0;
      const fresh = journal.filter((c) => c.seq > since);
      const batch = fresh.slice(0, options.pageSize || 500);
      return reply({
        cursor: batch.length ? batch[batch.length - 1].seq : since,
        hasMore: fresh.length > batch.length,
        changes: batch.map((c) => ({ seq: c.seq, record: c.record })),
      });
    }

    return reply({ error: 'нет такого' }, 404);
  };

  return {
    records,
    journal,
    seed(list) {
      for (const rec of list) {
        records.set(rec.id, rec);
        journal.push({ seq: (seq += 1), record: rec });
      }
    },
  };
}

const syncRec = (over = {}) => ({
  id: 's1', type: 'expense', amount: 100, category: 'Еда', note: '',
  start: '2026-09-01', repeat: 'none', repeatEvery: 1, weekdays: [], end: null,
  rev: 1, deleted: 0, ...over,
});

const rejects = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};

async function syncTests() {
  const S = A.Sync;

  /* --- сервера нет: приложение работает как раньше --- */
  S.disconnect();
  requests.length = 0;
  check('синхронизация изначально выключена', S.isOn(), false);

  A.state.transactions = [];
  addOn('2026-09-05', 'expense', 500, 'Еда', 'обед');
  A.save();
  check('без сервера данные записаны', JSON.parse(store.get('pb.transactions.v2')).length, 1);
  check('без сервера в сеть не ходили', requests.length, 0);
  check('счётчик у новой записи появился при чтении', A.load()[0].rev, 1);

  /* --- адрес и пароль проверяются до похода в сеть --- */
  let err = await rejects(() => S.connect('http://без-шифрования', PASSWORD));
  check('http-адрес отвергнут', /https/.test(err.message), true);

  serverHandler = async () => reply({ error: 'Неверный пароль' }, 401);
  err = await rejects(() => S.connect(HOST, 'не тот'));
  check('неверный пароль отвергнут', err.message, 'Неверный пароль');
  check('после неудачного входа сервер не подключён', S.isOn(), false);

  /* --- первый вход забирает всё с сервера --- */
  const server = fakeServer();
  server.seed([syncRec({ id: 'a' }), syncRec({ id: 'b', type: 'income', amount: 900 })]);

  A.state.transactions = [];
  const changed = await S.connect(HOST, PASSWORD);
  check('подключение сообщило об изменениях', changed, true);
  check('операции приехали с сервера', A.state.transactions.length, 2);
  check('сумма приехала целой', A.state.transactions.find((t) => t.id === 'a').amount, 100);
  check('счётчик изменений приехал', A.state.transactions.find((t) => t.id === 'a').rev, 1);
  check('подключение включено', S.isOn(), true);
  check('курсор дошёл до конца журнала', S._state().cursor, server.journal.length);
  check('второй обмен уже ничего не приносит', await S.run(), false);

  /* --- правка поднимает rev и уходит на сервер --- */
  requests.length = 0;
  A.startEdit('a');
  getEl('amount').value = '750';
  submitForm();
  check('правка подняла rev', A.state.transactions.find((t) => t.id === 'a').rev, 2);

  await S.run();
  check('правка дошла до сервера', server.records.get('a').amount, 750);
  check('на сервере тоже rev 2', server.records.get('a').rev, 2);
  check('в отправке была только изменённая запись', sentRecords().length, 1);

  /* --- отправленное не отправляется снова --- */
  requests.length = 0;
  await S.run();
  check('повторный обмен молчит', requests.filter((r) => r.options.method === 'POST').length, 0);

  /* --- удаление долетает и не воскресает --- */
  confirmAnswer = true;
  A.removeTx('a');
  check('удалённой записи нет в учёте', A.state.transactions.some((t) => t.id === 'a'), false);
  check('удаление запомнено как надгробие', S._state().graves.get('a').rev, 3);

  await S.run();
  check('удаление дошло до сервера', server.records.get('a').deleted, 1);
  check('после обмена удаление не вернулось',
    A.state.transactions.some((t) => t.id === 'a'), false);

  /* --- правка на втором устройстве видна первому --- */
  server.seed([syncRec({ id: 'c', note: 'из телефона', rev: 1 })]);
  check('чужая правка принята', await S.run(), true);
  check('новая запись появилась', A.state.transactions.some((t) => t.id === 'c'), true);
  check('назначение приехало', A.state.transactions.find((t) => t.id === 'c').note, 'из телефона');

  /* --- устройство отстало: чужой rev главнее --- */
  check('равный rev принимается как есть', S.merge(3, 3), 'take');
  check('меньший rev откладывается', S.merge(3, 2), 'keep');
  check('известен rev удалённой записи', S.knownRev('a'), 3);

  /* --- сервер прислал мусор --- */
  const beforeCount = A.state.transactions.length;
  S.applyRemote(syncRec({ id: 'мусор', amount: 0 }));
  check('операция без суммы не попала в учёт',
    A.state.transactions.some((t) => t.id === 'мусор'), false);
  check('мусор закрыт надгробием, чтобы не приходить снова',
    S._state().graves.has('мусор'), true);
  check('живые записи не пострадали', A.state.transactions.length, beforeCount);

  S.applyRemote({ id: 'ещё-мусор', type: 'неизвестно' });
  check('запись с чужим типом отвергнута',
    A.state.transactions.some((t) => t.id === 'ещё-мусор'), false);

  /* --- постраничное чтение --- */
  S.disconnect();
  requests.length = 0;
  const many = fakeServer({ pageSize: 2 });
  many.seed(Array.from({ length: 7 }, (_, i) => syncRec({ id: `p${i}`, rev: 1 })));
  A.state.transactions = [];
  await S.connect(HOST, PASSWORD);
  check('все записи дочитаны постранично', A.state.transactions.length, 7);
  check('запросов на чтение было больше одного',
    requests.filter((r) => r.url.includes('/api/changes') && !r.options.method).length > 1, true);

  /* --- «удалить всё» доходит до сервера --- */
  S.disconnect();
  const wipe = fakeServer();
  wipe.seed([syncRec({ id: 'w1' }), syncRec({ id: 'w2' })]);
  A.state.transactions = [];
  await S.connect(HOST, PASSWORD);
  check('перед очисткой две операции', A.state.transactions.length, 2);

  confirmAnswer = true;
  A.clearAll();
  check('учёт очищен', A.state.transactions.length, 0);

  await S.run();
  check('на сервере обе операции помечены удалёнными',
    [wipe.records.get('w1').deleted, wipe.records.get('w2').deleted], [1, 1]);
  check('очищенные операции не вернулись', await S.run(), false);
  check('после очистки учёт пуст', A.state.transactions.length, 0);

  /* --- первый вход: локальный учёт уходит на сервер --- */
  S.disconnect();
  const up = fakeServer();
  /* сервер знает только «a»; «local» и правка «a» живут только на устройстве */
  up.seed([syncRec({ id: 'a', amount: 100, rev: 1 })]);
  A.state.transactions = [
    { ...syncRec({ id: 'a', amount: 999, rev: 4 }), note: 'правка на устройстве' },
    syncRec({ id: 'local', amount: 250 }),
  ];

  await S.connect(HOST, PASSWORD);
  check('свежая локальная правка перебила серверную', A.state.transactions.find((t) => t.id === 'a').amount, 999);
  check('опередившая версия отправлена', up.records.get('a').amount, 999);
  check('опередившая версия с её rev', up.records.get('a').rev, 4);
  check('незнакомая серверу запись тоже ушла', up.records.get('local').amount, 250);
  check('всего на сервере две записи', up.records.size, 2);
  check('повторный обмен после входа пуст', await S.run(), false);

  /* --- отправка падает, чтение продолжается --- */
  S.disconnect();
  const half = fakeServer();
  half.seed([syncRec({ id: 'h1' })]);
  A.state.transactions = [];
  await S.connect(HOST, PASSWORD);
  check('до обрыва запись на месте', A.state.transactions.some((t) => t.id === 'h1'), true);

  /* сервер принимает чтение, но отказывает в отправке */
  const real = serverHandler;
  serverHandler = async (url, opts = {}) => {
    if (opts.method === 'POST') return reply({ error: 'слишком много' }, 413);
    return real(url, opts);
  };

  half.seed([syncRec({ id: 'h2' })]);
  A.startEdit('h1');
  getEl('amount').value = '1234';
  submitForm();

  check('при сбое отправки чужие изменения всё же приехали', await S.run(), true);
  check('новая запись с сервера видна', A.state.transactions.some((t) => t.id === 'h2'), true);
  check('локальная правка на месте', A.state.transactions.find((t) => t.id === 'h1').amount, 1234);
  check('статус показывает ошибку', S.status(), 'error');
  check('подключение не слетело', S.isOn(), true);

  serverHandler = real;
  check('после починки обмен снова проходит', await S.run(), false);
  check('ошибка снята', S.status(), 'on');

  /* --- сеть упала: учёт не пострадал --- */
  S.disconnect();
  A.state.transactions = [];
  addOn('2026-09-07', 'expense', 300, 'Прочее', 'тест');
  serverHandler = async () => { throw new Error('сеть недоступна'); };

  err = await rejects(() => S.connect(HOST, PASSWORD));
  check('недоступный сервер не проходит молча', err !== null, true);
  check('после обрыва подключение выключено', S.isOn(), false);
  check('операция осталась на месте', A.state.transactions.length, 1);
  check('сумма операции цела', A.state.transactions[0].amount, 300);

  /* --- сервер ответил 401 посреди работы --- */
  const live = fakeServer();
  live.seed([syncRec({ id: 'z' })]);
  A.state.transactions = [];
  await S.connect(HOST, PASSWORD);
  serverHandler = async () => reply({ error: 'сессия истекла' }, 401);
  await S.run();
  check('отказ сервера снимает подключение', S.isOn(), false);
  check('статус показывает ошибку', S.status(), 'error');
  check('данные, уже полученные, остались', A.state.transactions.some((t) => t.id === 'z'), true);

  S.disconnect();
  check('отключение убирает следы', localStorage.getItem('pb.sync.config.v1'), null);
  check('после отключения синхронизация выключена', S.isOn(), false);

  serverHandler = null;
}

syncTests().then(() => {
  console.log(`\nПроверок пройдено: ${passed}`);
  console.log(`Провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.log(`\nТест синхронизации упал: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
