/* Личный бюджет — календарь с плитками дней и повторяющимися операциями.
   Данные хранятся в localStorage браузера. */

const STORAGE_KEY = 'pb.transactions.v2';
const EXPORT_STAMP_KEY = 'pb.lastExport';
const BACKUP_INTERVAL_DAYS = 30;
const DAY_MS = 86400000;

const EXPENSE_CATEGORIES = [
  'Продукты',
  'Транспорт',
  'Жильё и коммуналка',
  'Здоровье',
  'Развлечения',
  'Одежда',
  'Образование',
  'Прочее',
];

const INCOME_CATEGORIES = ['Зарплата', 'Подработка', 'Перевод', 'Прочее'];

const CATEGORY_ICONS = {
  'Продукты': '🛒',
  'Транспорт': '🚌',
  'Жильё и коммуналка': '🏠',
  'Здоровье': '💊',
  'Развлечения': '🎬',
  'Одежда': '👕',
  'Образование': '📚',
  'Прочее': '📦',
  'Зарплата': '💼',
  'Подработка': '💻',
  'Перевод': '↩️',
};

/* Дни недели в порядке Пн–Вс (ISO: 1…7) */
const WEEKDAYS = [
  { i: 1, short: 'Пн', name: 'понедельник' },
  { i: 2, short: 'Вт', name: 'вторник' },
  { i: 3, short: 'Ср', name: 'среда' },
  { i: 4, short: 'Чт', name: 'четверг' },
  { i: 5, short: 'Пт', name: 'пятница' },
  { i: 6, short: 'Сб', name: 'суббота' },
  { i: 7, short: 'Вс', name: 'воскресенье' },
];

const state = {
  transactions: [],
  month: currentMonth(),
  selected: null,
};

const monthCache = new Map();
const carryCache = new Map();

/* ---------- утилиты ---------- */

const $ = (id) => document.getElementById(id);

const money = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const plain = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

const fmtMoney = (value) => money.format(value).replace('-', '\u2212');

/* Компактная запись для плиток календаря: 950 / 1 250 / 12,5 к / 90 к */
function compact(value) {
  const abs = Math.abs(value);
  if (abs < 10000) return plain.format(Math.round(abs));

  const k = abs / 1000;
  const text = Number.isInteger(k) ? plain.format(k) : k.toFixed(1).replace('.', ',');
  return `${text}\u00a0к`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* Работаем в UTC, чтобы не ломать расчёты о часовых поясах и переходах на летнее время. */

function toUTC(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y || 1970, (m || 1) - 1, d || 1);
}

function fromUTC(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const isoDow = (ts) => new Date(ts).getUTCDay() || 7;

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftMonth(month, delta) {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

function longDate(iso) {
  return new Date(toUTC(iso)).toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function shortDate(iso) {
  return new Date(toUTC(iso)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function monthName(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function normalizeAmount(value) {
  return Math.round(Number(value) * 100) / 100;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--show'), 2400);
}

/* ---------- повторения ---------- */

const isRepeating = (tx) => !!tx.repeat && tx.repeat !== 'none';

/* Дни месяца, в которые попадает операция. Работает в UTC. */
function matchingDaysInMonth(tx, month) {
  const [year, m] = month.split('-').map(Number);
  const firstTs = Date.UTC(year, m - 1, 1);
  const total = daysInMonth(month);
  const startTs = toUTC(tx.start);
  const endTs = tx.end ? toUTC(tx.end) : null;
  const repeat = tx.repeat || 'none';

  if (repeat === 'none') {
    return startTs >= firstTs && startTs <= firstTs + (total - 1) * DAY_MS ? [startTs] : [];
  }

  const every = Math.max(1, Number(tx.repeatEvery) || 1);
  const days = [];

  for (let i = 0; i < total; i += 1) {
    const ts = firstTs + i * DAY_MS;
    if (ts < startTs) continue;
    if (endTs !== null && ts > endTs) continue;

    if (repeat === 'daily') {
      if (Math.floor((ts - startTs) / DAY_MS) % every === 0) days.push(ts);
    } else if (repeat === 'weekly') {
      const weeks = Math.floor((ts - startTs) / (7 * DAY_MS));
      if (weeks % every === 0) {
        const picked = tx.weekdays && tx.weekdays.length ? tx.weekdays : [isoDow(startTs)];
        if (picked.includes(isoDow(ts))) days.push(ts);
      }
    } else if (repeat === 'monthly') {
      const s = new Date(startTs);
      const t = new Date(ts);
      const months = (t.getUTCFullYear() - s.getUTCFullYear()) * 12
        + (t.getUTCMonth() - s.getUTCMonth());
      if (months % every === 0 && t.getUTCDate() === s.getUTCDate()) days.push(ts);
    }
  }

  return days;
}

function repeatLabel(tx) {
  if (!isRepeating(tx)) return null;
  const every = Math.max(1, Number(tx.repeatEvery) || 1);
  const until = tx.end ? ` до ${shortDate(tx.end)}` : '';

  if (tx.repeat === 'daily') {
    return every === 1 ? `каждый день${until}` : `каждые ${every} ${plural(every, 'день', 'дня', 'дней')}${until}`;
  }

  if (tx.repeat === 'weekly') {
    const picked = tx.weekdays && tx.weekdays.length ? tx.weekdays : [isoDow(toUTC(tx.start))];
    const names = WEEKDAYS.filter((d) => picked.includes(d.i)).map((d) => d.short).join(', ');
    const head = every === 1 ? 'еженедельно' : `каждые ${every} ${plural(every, 'неделю', 'недели', 'недель')}`;
    return `${head}: ${names}${until}`;
  }

  const dayNum = Number(String(tx.start).slice(8, 10));
  const head = every === 1 ? 'ежемесячно' : `каждые ${every} ${plural(every, 'месяц', 'месяца', 'месяцев')}`;
  return `${head}, ${dayNum}-го числа${until}`;
}

/* ---------- хранение ---------- */

function normalizeRecord(raw) {
  if (!raw || (raw.type !== 'income' && raw.type !== 'expense')) return null;

  const amount = normalizeAmount(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  /* Поддержка данных из первой версии: там была поле date вместо start. */
  const start = /^\d{4}-\d{2}-\d{2}$/.test(raw.start || '') ? raw.start
    : /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date
      : todayISO();

  const repeat = ['daily', 'weekly', 'monthly'].includes(raw.repeat) ? raw.repeat : 'none';

  return {
    id: String(raw.id || uid()),
    type: raw.type,
    amount,
    category: String(raw.category || 'Прочее'),
    note: String(raw.note || ''),
    start,
    repeat,
    repeatEvery: repeat === 'none' ? 1 : Math.min(365, Math.max(1, Number(raw.repeatEvery) || 1)),
    weekdays: repeat === 'weekly' && Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.map(Number).filter((d) => d >= 1 && d <= 7))].sort()
      : [],
    end: /^\d{4}-\d{2}-\d{2}$/.test(raw.end || '') ? raw.end : null,
  };
}

function load() {
  let parsed = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) parsed = data;
    }
  } catch (err) {
    console.warn('Не удалось прочитать сохранённые данные:', err);
  }
  return parsed.map(normalizeRecord).filter(Boolean);
}

function invalidateCaches() {
  monthCache.clear();
  carryCache.clear();
}

function save() {
  invalidateCaches();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.transactions));
  } catch (err) {
    console.error('Не удалось сохранить данные:', err);
    toast('Не удалось сохранить данные в браузере');
  }
}

/* ---------- накопленный баланс ---------- */

/* Баланс месяца без построения суточного индекса: число попаданий операции
   в месяц умножаем на сумму. Нужен, чтобы не зациклиться — построение
   индекса само обращается к накопленному балансу предыдущего месяца. */
function rawMonthBalance(month) {
  let balance = 0;
  for (const tx of state.transactions) {
    const hits = matchingDaysInMonth(tx, month).length;
    if (!hits) continue;
    balance += tx.type === 'income' ? tx.amount * hits : -tx.amount * hits;
  }
  return balance;
}

/* Самый ранний месяц с данными. */
function earliestMonth() {
  let first = null;
  for (const tx of state.transactions) {
    const month = String(tx.start).slice(0, 7);
    if (!first || month < first) first = month;
  }
  return first;
}

/* Сколько накопилось на 1-е число указанного месяца.
   В кеше под ключом m всегда хранится именно сумма ДО месяца m. */
function carryInto(month) {
  if (carryCache.has(month)) return carryCache.get(month);

  const first = earliestMonth();
  if (!first || month <= first) {
    carryCache.set(month, 0);
    return 0;
  }

  let carry = 0;

  for (let m = first; m !== month; m = shiftMonth(m, 1)) {
    const next = shiftMonth(m, 1);

    /* Оба значения уже известны — перепрыгиваем месяц целиком. */
    if (carryCache.has(m) && carryCache.has(next)) {
      carry = carryCache.get(next);
      continue;
    }

    carry = (carryCache.has(m) ? carryCache.get(m) : carry) + rawMonthBalance(m);
    if (!carryCache.has(next)) carryCache.set(next, carry);
  }

  return carry;
}

/* ---------- индекс месяца ---------- */

function monthIndex(month) {
  if (!monthCache.has(month)) monthCache.set(month, buildMonthIndex(month, carryInto(month)));
  return monthCache.get(month);
}

function buildMonthIndex(month, carry) {
  const total = daysInMonth(month);
  const days = new Map();

  for (let i = 1; i <= total; i += 1) {
    const iso = `${month}-${String(i).padStart(2, '0')}`;
    days.set(iso, { iso, day: i, income: 0, expense: 0, items: [], hasRepeat: false });
  }

  for (const tx of state.transactions) {
    for (const ts of matchingDaysInMonth(tx, month)) {
      const cell = days.get(fromUTC(ts));
      if (!cell) continue;
      cell.items.push(tx);
      if (tx.type === 'income') cell.income += tx.amount;
      else cell.expense += tx.amount;
      if (isRepeating(tx)) cell.hasRepeat = true;
    }
  }

  /* Map хранится в порядке вставки, то есть от 1-го числа к последнему,
     поэтому накопленный итог считается простым проходом. */
  let running = carry;
  for (const cell of days.values()) {
    cell.balance = cell.income - cell.expense;
    running += cell.balance;
    cell.cumulative = running;
  }

  return days;
}

const monthTotals = (month) => {
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const cell of monthIndex(month).values()) {
    income += cell.income;
    expense += cell.expense;
    count += cell.items.length;
  }
  return { income, expense, balance: income - expense, count };
};

/* ---------- отрисовка: итоги ---------- */

function renderSummary() {
  const totals = monthTotals(state.month);
  $('monthTitle').textContent = monthName(state.month);

  const count = totals.count;
  $('monthCount').textContent = count
    ? `${count} ${plural(count, 'операция', 'операции', 'операций')}`
    : 'нет операций';

  $('sumIncome').textContent = fmtMoney(totals.income);
  $('sumExpense').textContent = fmtMoney(totals.expense);
  $('sumBalance').textContent = fmtMoney(totals.balance);
}

/* ---------- отрисовка: календарь ---------- */

function dayButton(cell, today) {
  const classes = ['day'];
  if (cell.iso === today) classes.push('day--today');
  if (cell.iso === state.selected) classes.push('day--open');

  const weekend = isoDow(toUTC(cell.iso)) >= 6;

  /* Нулевые приход и расход показываем приглушённо, чтобы структура «три числа» читалась. */
  const row = (cls, sign, value) => {
    const muted = value === 0 && cls !== 'day__val--bal' ? ' day__val--zero' : '';
    return `<span class="day__val ${cls}${muted}"><span class="day__sign">${sign}</span>${compact(value)}</span>`;
  };

  const cumulativeSign = cell.cumulative > 0 ? '+' : cell.cumulative < 0 ? '−' : '';
  const title = `${longDate(cell.iso)}: приход ${fmtMoney(cell.income)}, `
    + `расход ${fmtMoney(cell.expense)}, за день ${fmtMoney(cell.balance)}, `
    + `накопленным итогом ${fmtMoney(cell.cumulative)}`;

  return `
    <button type="button" class="${classes.join(' ')}" data-date="${cell.iso}" title="${escapeHtml(title)}"
            aria-label="${escapeHtml(title)}">
      <span class="day__num${weekend ? ' day__num--weekend' : ''}">${cell.day}</span>
      ${cell.hasRepeat ? '<span class="day__replay" title="Есть повторяющиеся операции">↻</span>' : ''}
      <span class="day__vals">
        ${row('day__val--in', '+', cell.income)}
        ${row('day__val--out', '−', cell.expense)}
        ${row('day__val--bal', cumulativeSign, cell.cumulative)}
      </span>
    </button>`;
}

function renderCalendar() {
  const month = state.month;
  const today = todayISO();
  const days = monthIndex(month);

  const firstIso = `${month}-01`;
  const lead = isoDow(toUTC(firstIso)) - 1; /* сколько пустых плиток до 1-го числа */
  const total = days.size;
  const tail = (7 - ((lead + total) % 7)) % 7;

  let html = '';
  for (let i = 0; i < lead; i += 1) html += '<div class="day day--out"></div>';
  for (const cell of days.values()) html += dayButton(cell, today);
  for (let i = 0; i < tail; i += 1) html += '<div class="day day--out"></div>';

  $('calendar').innerHTML = html;
}

/* ---------- отрисовка: разбивка и график ---------- */

function renderBreakdown() {
  const totals = new Map();
  for (const cell of monthIndex(state.month).values()) {
    for (const tx of cell.items) {
      if (tx.type !== 'expense') continue;
      totals.set(tx.category, (totals.get(tx.category) || 0) + tx.amount);
    }
  }

  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    $('breakdown').innerHTML = '<p class="empty">Расходов в этом месяце нет</p>';
    return;
  }

  const max = rows[0][1];
  $('breakdown').innerHTML = rows
    .map(([name, value]) => `
      <div class="bar__row">
        <span class="bar__name">${escapeHtml(name)}</span>
        <span class="bar__value">${fmtMoney(value)}</span>
        <div class="bar__track"><div class="bar__fill" style="width:${((value / max) * 100).toFixed(1)}%"></div></div>
      </div>`)
    .join('');
}

function renderTrend() {
  const months = [];
  for (let i = 5; i >= 0; i -= 1) months.push(shiftMonth(state.month, -i));

  const data = months.map((month) => ({ month, ...monthTotals(month) }));

  if (!data.some((d) => d.income > 0 || d.expense > 0)) {
    $('trend').innerHTML = '<p class="empty">Пока нет данных за этот период</p>';
    return;
  }

  const W = 620;
  const H = 190;
  const padTop = 12;
  const base = H - 24;
  const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.expense)));
  const slot = W / data.length;
  const barW = Math.min(30, slot / 2 - 8);
  const scale = (v) => (v / max) * (base - padTop);

  const bars = data
    .map((d, i) => {
      const center = slot * i + slot / 2;
      const hIn = Math.max(d.income > 0 ? 2 : 0, scale(d.income));
      const hOut = Math.max(d.expense > 0 ? 2 : 0, scale(d.expense));
      const label = `${d.month.slice(5)}.${d.month.slice(2, 4)}`;
      return `
        <g>
          <title>${label}: доход ${fmtMoney(d.income)}, расход ${fmtMoney(d.expense)}</title>
          <rect x="${(center - barW - 3).toFixed(1)}" y="${(base - hIn).toFixed(1)}" width="${barW.toFixed(1)}"
                height="${hIn.toFixed(1)}" rx="4" fill="var(--income)"></rect>
          <rect x="${(center + 3).toFixed(1)}" y="${(base - hOut).toFixed(1)}" width="${barW.toFixed(1)}"
                height="${hOut.toFixed(1)}" rx="4" fill="var(--expense)"></rect>
          <text x="${center.toFixed(1)}" y="${H - 6}" text-anchor="middle"
                font-size="11" fill="var(--muted)">${label}</text>
        </g>`;
    })
    .join('');

  $('trend').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Доходы и расходы за последние 6 месяцев">
      <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="var(--border)" stroke-width="1"></line>
      ${bars}
    </svg>`;
}

/* ---------- отрисовка: панель дня ---------- */

function renderDayPanel() {
  if (!state.selected) return;

  const cell = monthIndex(state.month).get(state.selected);
  if (!cell) {
    closeDay();
    return;
  }

  $('dayTitle').textContent = longDate(state.selected);
  $('daySub').textContent = cell.items.length
    ? `${cell.items.length} ${plural(cell.items.length, 'операция', 'операции', 'операций')}`
    : 'операций нет';

  $('dayIncome').textContent = `приход ${fmtMoney(cell.income)}`;
  $('dayExpense').textContent = `расход ${fmtMoney(cell.expense)}`;
  $('dayBalance').textContent = `за день ${fmtMoney(cell.balance)}`;
  $('dayCumulative').textContent = `накопленным ${fmtMoney(cell.cumulative)}`;

  if (!cell.items.length) {
    $('dayList').innerHTML = '<p class="empty">В этот день операций не было</p>';
    return;
  }

  const sorted = [...cell.items].sort((a, b) => {
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.type === b.type ? 0 : a.type === 'income' ? -1 : 1;
  });

  $('dayList').innerHTML = sorted
    .map((tx) => {
      const sign = tx.type === 'income' ? '+' : '−';
      const repeat = repeatLabel(tx);
      const when = isRepeating(tx) && tx.start !== state.selected
        ? `с ${shortDate(tx.start)}`
        : '';
      return `
        <article class="item">
          <div class="item__icon">${CATEGORY_ICONS[tx.category] || '💰'}</div>
          <div class="item__main">
            <div class="item__cat">${escapeHtml(tx.category)}</div>
            ${tx.note ? `<div class="item__note">${escapeHtml(tx.note)}</div>` : ''}
            ${repeat ? `<div class="item__meta">↻ ${escapeHtml(repeat)}${when ? `, ${escapeHtml(when)}` : ''}</div>` : ''}
          </div>
          <span class="item__amount item__amount--${tx.type}">${sign}${fmtMoney(tx.amount)}</span>
          <div class="item__actions">
            <button type="button" class="icon-btn" data-edit="${escapeHtml(tx.id)}" title="Изменить">&#9998;</button>
            <button type="button" class="icon-btn icon-btn--del" data-del="${escapeHtml(tx.id)}" title="Удалить">&times;</button>
          </div>
        </article>`;
    })
    .join('');
}

function openDay(iso) {
  if (!monthIndex(state.month).has(iso)) state.month = iso.slice(0, 7);
  state.selected = iso;

  $('backdrop').hidden = false;
  $('dayPanel').hidden = false;
  document.body.classList.add('panel-open');
  resetForm();
  render();
  $('amount').focus();
}

function closeDay() {
  state.selected = null;
  $('backdrop').hidden = true;
  $('dayPanel').hidden = true;
  document.body.classList.remove('panel-open');
  resetForm();
  render();
}

/* ---------- форма ---------- */

function currentFormType() {
  return document.querySelector('input[name="type"]:checked').value;
}

function fillCategories(selected) {
  const list = currentFormType() === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const select = $('category');
  select.innerHTML = '';
  for (const name of list) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    if (name === selected) option.selected = true;
    select.append(option);
  }
}

function buildWeekdayPicker() {
  $('weekdayPicker').innerHTML = WEEKDAYS
    .map((d) => `
      <label class="weekday" title="${d.name}">
        <input type="checkbox" value="${d.i}"><span>${d.short}</span>
      </label>`)
    .join('');
}

/* ---------- словарь назначений ---------- */

/* Собирается из заметок всех операций, отдельного хранилища не нужно.
   Вместе с каждым значением хранится, сколько раз его использовали и
   в операциях какого типа — по этому же типу подсказки встают вперёд. */
function noteDictionary() {
  const counts = new Map();

  for (const tx of state.transactions) {
    const note = String(tx.note || '').trim();
    if (!note) continue;

    const entry = counts.get(note) || { note, count: 0, types: new Set() };
    entry.count += 1;
    entry.types.add(tx.type);
    counts.set(note, entry);
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.note.localeCompare(b.note, 'ru'));
}

/* Подсказки для текущего ввода: совпадения по подстроке, сверху —
   назначения того же типа операции, затем самые частые. */
function noteSuggestions() {
  const query = $('note').value.trim().toLowerCase();
  const type = currentFormType();

  return noteDictionary()
    .filter((entry) => !query || entry.note.toLowerCase().includes(query))
    .sort((a, b) => {
      const own = (entry) => (entry.types.has(type) ? 0 : 1);
      return own(a) - own(b) || b.count - a.count || a.note.localeCompare(b.note, 'ru');
    });
}

const NOTE_LIMIT = 12;
let noteActive = -1;

function renderNoteSuggestions() {
  const list = $('noteList');
  const items = noteSuggestions().slice(0, NOTE_LIMIT);

  if (!items.length) {
    closeNoteSuggestions();
    return;
  }

  list.innerHTML = items.map((entry) => `
    <li class="combo__item" role="option" aria-selected="false"
        data-note="${escapeHtml(entry.note)}">
      <span>${escapeHtml(entry.note)}</span>
      <small>${entry.count} ${plural(entry.count, 'раз', 'раза', 'раз')}</small>
    </li>`).join('');

  noteActive = -1;
  list.hidden = false;
  $('note').setAttribute('aria-expanded', 'true');
}

function closeNoteSuggestions() {
  $('noteList').hidden = true;
  $('noteList').innerHTML = '';
  noteActive = -1;
  $('note').setAttribute('aria-expanded', 'false');
}

function highlightNote(step) {
  const items = [...$('noteList').querySelectorAll('.combo__item')];
  if (!items.length) return;

  items.forEach((item) => item.setAttribute('aria-selected', 'false'));
  noteActive = (noteActive + step + items.length) % items.length;

  const active = items[noteActive];
  active.setAttribute('aria-selected', 'true');
  active.scrollIntoView({ block: 'nearest' });
}

function pickNote(note) {
  $('note').value = note;
  closeNoteSuggestions();
}

function activeNoteValue() {
  const item = $('noteList').querySelector('.combo__item[aria-selected="true"]');
  return item ? item.dataset.note : null;
}

function updateNoteHelp() {
  const total = noteDictionary().length;
  $('noteHelp').textContent = total
    ? `Подсказки из ${total} ${plural(total, 'прошлой записи', 'прошлых записей', 'прошлых записей')}`
    : 'Подсказки появятся после первой записи с назначением';
}

function onNoteKeyDown(event) {
  const open = !$('noteList').hidden;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!open) renderNoteSuggestions();
    else highlightNote(event.key === 'ArrowDown' ? 1 : -1);
    event.preventDefault();
    return;
  }

  if (event.key === 'Enter' && open) {
    const value = activeNoteValue();
    /* без выделения Enter должен отправить форму, а не выбрать подсказку */
    if (value !== null) {
      event.preventDefault();
      pickNote(value);
    }
    return;
  }

  if (event.key === 'Escape') {
    if (!open) return;
    event.preventDefault();
    /* гасим всплытие, иначе Esc закроет ещё и панель дня */
    event.stopPropagation();
    closeNoteSuggestions();
  }
}

function onNoteListMouseDown(event) {
  /* без этого поле теряет фокус раньше, чем сработает click */
  event.preventDefault();
}

function onNoteListClick(event) {
  const item = event.target.closest('.combo__item');
  if (item) pickNote(item.dataset.note);
}

function syncRepeatFields() {
  const repeat = $('repeat').value;
  $('everyField').hidden = repeat === 'none';
  $('weekdaysField').hidden = repeat !== 'weekly';
  $('untilField').hidden = repeat === 'none';

  const units = { daily: 'дней', weekly: 'недель', monthly: 'месяцев' };
  $('everyHelp').textContent = units[repeat] || '';
}

function updateFormTitle() {
  const base = $('editId').value ? 'Изменение операции' : 'Новая операция';
  $('formTitle').textContent = state.selected ? `${base} · ${shortDate(state.selected)}` : base;
}

function setWeekdays(days) {
  for (const input of $('weekdayPicker').querySelectorAll('input')) {
    input.checked = days.includes(Number(input.value));
  }
}

function getWeekdays() {
  return [...$('weekdayPicker').querySelectorAll('input:checked')].map((i) => Number(i.value));
}

function resetForm() {
  $('txForm').reset();
  $('editId').value = '';
  $('repeat').value = 'none';
  $('repeatEvery').value = '1';
  $('untilDate').value = '';
  $('submitBtn').textContent = 'Добавить';
  $('cancelBtn').hidden = true;
  $('formHint').hidden = true;
  $('formTitle').textContent = 'Новая операция';

  const typeRadio = document.querySelector('input[name="type"][value="expense"]');
  if (typeRadio) typeRadio.checked = true;

  fillCategories();
  setWeekdays([]);
  syncRepeatFields();
  closeNoteSuggestions();
  updateFormTitle();
}

function startEdit(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) return;

  document.querySelector(`input[name="type"][value="${tx.type}"]`).checked = true;
  fillCategories(tx.category);

  $('amount').value = tx.amount;
  $('note').value = tx.note;
  $('repeat').value = tx.repeat;
  $('repeatEvery').value = tx.repeatEvery;
  $('untilDate').value = tx.end || '';
  setWeekdays(tx.weekdays && tx.weekdays.length ? tx.weekdays : [isoDow(toUTC(tx.start))]);

  $('editId').value = tx.id;
  $('submitBtn').textContent = 'Сохранить';
  $('cancelBtn').hidden = false;
  $('formTitle').textContent = 'Изменение операции';

  if (isRepeating(tx)) {
    $('formHint').hidden = false;
    $('formHint').textContent = `Повторяющаяся операция (${repeatLabel(tx)}). `
      + 'Изменения применятся ко всем повторениям.';
  }

  syncRepeatFields();
  updateFormTitle();
  $('amount').focus();
}

function onSubmit(event) {
  event.preventDefault();

  const amount = normalizeAmount($('amount').value);
  if (!Number.isFinite(amount) || amount <= 0) {
    toast('Введите сумму больше нуля');
    $('amount').focus();
    return;
  }

  const repeat = $('repeat').value;
  const editId = $('editId').value;
  const existing = editId ? state.transactions.find((t) => t.id === editId) : null;

  const start = existing ? existing.start : state.selected || todayISO();
  const end = $('untilDate').value || null;

  if (end && end < start) {
    toast('Дата окончания раньше даты начала');
    $('untilDate').focus();
    return;
  }

  const payload = {
    type: currentFormType(),
    amount,
    category: $('category').value,
    note: $('note').value.trim(),
    start,
    repeat,
    repeatEvery: Math.min(365, Math.max(1, Number($('repeatEvery').value) || 1)),
    weekdays: repeat === 'weekly' ? getWeekdays() : [],
    end: repeat === 'none' ? null : end,
  };

  if (!payload.weekdays.length && repeat === 'weekly') {
    payload.weekdays = [isoDow(toUTC(start))];
  }

  if (existing) {
    Object.assign(existing, payload);
  } else {
    state.transactions.push({ id: uid(), ...payload });
  }

  save();

  /* Если операцию перенесли в другой месяц — показываем тот месяц. */
  if (start.slice(0, 7) !== state.month) {
    state.month = start.slice(0, 7);
  }

  render();
  resetForm();
  $('amount').focus();

  const word = repeat === 'none' ? '' : ' и повторится';
  toast(`${existing ? 'Операция обновлена' : 'Операция добавлена'}${word}`);
}

/* ---------- импорт, экспорт, очистка ---------- */

function exportData() {
  const blob = new Blob([JSON.stringify(state.transactions, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `budget-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);

  try {
    localStorage.setItem(EXPORT_STAMP_KEY, String(Date.now()));
  } catch (err) {
    /* отметку о копии можно и не сохранить — это не влияет на данные */
  }

  renderBackupNotice();
  toast('Файл с данными сохранён');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!Array.isArray(parsed)) throw new Error('Ожидался список операций');
      const cleaned = parsed.map(normalizeRecord).filter(Boolean);
      state.transactions = cleaned;
      save();
      render();
      toast(`Загружено операций: ${cleaned.length}`);
    } catch (err) {
      console.error(err);
      toast('Не удалось прочитать файл');
    }
  };
  reader.onerror = () => toast('Не удалось прочитать файл');
  reader.readAsText(file);
}

function clearAll() {
  if (!state.transactions.length) {
    toast('Данных пока нет');
    return;
  }
  const count = state.transactions.length;
  if (!confirm(`Удалить все операции (${count} шт.)? Действие необратимо.`)) return;
  state.transactions = [];
  save();
  render();
  toast('Все операции удалены');
}

/* ---------- напоминание о резервной копии ---------- */

/* Данные лежат только в этом браузере, поэтому единственная страховка от их
   потери — файл копии. Напоминание появляется, пока копия не выгружена. */
function lastExportAt() {
  return Number(localStorage.getItem(EXPORT_STAMP_KEY) || 0) || null;
}

function renderBackupNotice() {
  /* Пустой учёт напоминать не о чем. */
  if (!state.transactions.length) {
    $('backupNotice').hidden = true;
    return;
  }

  const stamp = lastExportAt();
  const days = stamp ? Math.floor((Date.now() - stamp) / DAY_MS) : null;

  $('backupNotice').hidden = days !== null && days < BACKUP_INTERVAL_DAYS;
  $('backupNoticeText').textContent = days === null
    ? 'Данные хранятся только в этом браузере — стоит выгрузить резервную копию.'
    : `Резервная копия не выгружалась ${days} ${plural(days, 'день', 'дня', 'дней')}. `
      + 'Данные хранятся только в этом браузере.';
}

/* ---------- общее ---------- */

function render() {
  renderSummary();
  renderCalendar();
  renderBreakdown();
  renderTrend();
  updateNoteHelp();
  renderBackupNotice();
  if (state.selected) renderDayPanel();
}

function goToMonth(month) {
  state.month = month;
  closeDayIfOtherMonth();
  render();
}

function closeDayIfOtherMonth() {
  if (state.selected && state.selected.slice(0, 7) !== state.month) {
    state.selected = null;
    $('backdrop').hidden = true;
    $('dayPanel').hidden = true;
    document.body.classList.remove('panel-open');
  }
}

/* ---------- события календаря ---------- */

function onCalendarClick(event) {
  const day = event.target.closest('.day[data-date]');
  if (day) openDay(day.dataset.date);
}

function onDayListClick(event) {
  const editBtn = event.target.closest('[data-edit]');
  if (editBtn) {
    startEdit(editBtn.dataset.edit);
    return;
  }
  const delBtn = event.target.closest('[data-del]');
  if (delBtn) removeTx(delBtn.dataset.del);
}

function removeTx(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) return;

  const question = isRepeating(tx)
    ? `Удалить повторяющуюся операцию «${tx.category}», ${fmtMoney(tx.amount)}?\n`
      + 'Будут удалены все её повторения.'
    : `Удалить операцию «${tx.category}», ${fmtMoney(tx.amount)}?`;

  if (!confirm(question)) return;

  state.transactions = state.transactions.filter((t) => t.id !== id);
  save();
  render();
  toast('Операция удалена');
}

function onKeyDown(event) {
  if (event.key === 'Escape' && state.selected) closeDay();
}

/* ---------- инициализация ---------- */

function init() {
  state.transactions = load();
  invalidateCaches();
  buildWeekdayPicker();

  $('calendar').addEventListener('click', onCalendarClick);
  $('dayList').addEventListener('click', onDayListClick);
  $('txForm').addEventListener('submit', onSubmit);
  $('backdrop').addEventListener('click', closeDay);
  $('closePanel').addEventListener('click', closeDay);
  document.addEventListener('keydown', onKeyDown);

  for (const radio of document.querySelectorAll('input[name="type"]')) {
    radio.addEventListener('change', () => {
      fillCategories();
      /* подсказки назначений зависят от типа — пересобираем список */
      if (!$('noteList').hidden) renderNoteSuggestions();
    });
  }

  $('repeat').addEventListener('change', syncRepeatFields);

  $('note').addEventListener('focus', renderNoteSuggestions);
  $('note').addEventListener('input', renderNoteSuggestions);
  $('note').addEventListener('blur', closeNoteSuggestions);
  $('note').addEventListener('keydown', onNoteKeyDown);
  $('noteList').addEventListener('mousedown', onNoteListMouseDown);
  $('noteList').addEventListener('click', onNoteListClick);
  $('cancelBtn').addEventListener('click', () => {
    resetForm();
    toast('Изменение отменено');
  });

  $('prevMonth').addEventListener('click', () => goToMonth(shiftMonth(state.month, -1)));
  $('nextMonth').addEventListener('click', () => goToMonth(shiftMonth(state.month, 1)));
  $('todayBtn').addEventListener('click', () => {
    const today = todayISO();
    state.month = today.slice(0, 7);
    invalidateCaches();
    openDay(today);
  });

  $('exportBtn').addEventListener('click', exportData);
  $('backupBtn').addEventListener('click', exportData);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (event) => {
    if (event.target.files[0]) importData(event.target.files[0]);
    event.target.value = '';
  });
  $('clearBtn').addEventListener('click', clearAll);

  render();
  resetForm();
}

document.addEventListener('DOMContentLoaded', init);
