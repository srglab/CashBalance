/**
 * Синхронизация между устройствами.
 *
 * Приложение остаётся local-first: данные лежат в localStorage, и все
 * расчёты идут по ним. Сеть тут только фоновая надстройка — если сервер
 * недоступен или его вообще нет, приложение работает как раньше.
 *
 * Конфликты разрешаются счётчиком rev, а не временем: часы на устройствах
 * могут врать, а счётчик не врёт. Побеждает запись с бо́льшим rev.
 */

const CONFIG_KEY = 'pb.sync.config.v1';
const CURSOR_KEY = 'pb.sync.cursor.v1';
const GRAVE_KEY = 'pb.sync.graves.v1';

const PUSH_DELAY_MS = 1500;
const POLL_MS = 60000;
const PULL_GUARD = 50;

const Sync = (() => {
  /* Конфигурация и журнал синхронизации — не то же самое, что операции,
     поэтому лежат отдельными ключами и не попадают в экспорт. */
  let config = null;   // { url, token, expiresAt }
  let cursor = 0;      // до какого seq мы уже всё получили
  let graves = new Map(); // id -> операция с deleted: 1
  let pending = new Set(); // id изменений, ждущих отправки
  let status = 'off';  // off | busy | on | error
  let lastError = '';
  let pushTimer = null;
  let pollTimer = null;
  let inFlight = null;
  let listeners = [];

  /* ---------- хранилище ---------- */

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* не смогли сохранить служебное состояние — не повод ломать учёт */
    }
  }

  function readGraves() {
    const list = readJson(GRAVE_KEY, []);
    return new Map(list.map((rec) => [rec.id, rec]));
  }

  function writeGraves() {
    writeJson(GRAVE_KEY, [...graves.values()]);
  }

  function forget() {
    config = null;
    cursor = 0;
    graves = new Map();
    pending = new Set();
    for (const key of [CONFIG_KEY, CURSOR_KEY, GRAVE_KEY]) {
      try {
        localStorage.removeItem(key);
      } catch (err) { /* пусто */ }
    }
    setStatus('off');
  }

  /* ---------- уведомления ---------- */

  function setStatus(next, error = '') {
    status = next;
    lastError = error;
    for (const fn of listeners) {
      try {
        fn({ status, error, connected: !!config });
      } catch (err) { /* слушатель не должен ломать синхронизацию */ }
    }
  }

  function onChange(fn) {
    listeners.push(fn);
    fn({ status, error: lastError, connected: !!config });
  }

  /* ---------- сеть ---------- */

  async function api(path, options = {}) {
    if (!config) throw new Error('Синхронизация не настроена');
    if (config.expiresAt && config.expiresAt < Date.now()) {
      throw new Error('Сессия истекла, войдите заново');
    }

    const response = await fetch(`${config.url.replace(/\/+$/, '')}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${config.token}`,
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      config = null;
      writeJson(CONFIG_KEY, config);
      throw new Error('Пароль отклонён или сессия истекла');
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Сервер ответил ${response.status}${text ? `: ${text}` : ''}`);
    }

    return response.json();
  }

  /* ---------- слияние ---------- */

  /**
   * Решает, какая версия операции побеждает.
   * Возвращает 'keep' — оставить как есть, или 'take' — принять входящую.
   */
  function merge(localRev, incomingRev) {
    return incomingRev >= localRev ? 'take' : 'keep';
  }

  /** Текущий rev операции: запись может быть и удалена, тогда она в graves. */
  function knownRev(id) {
    const live = state.transactions.find((t) => t.id === id);
    const dead = graves.get(id);
    return Math.max(live ? live.rev || 1 : 0, dead ? dead.rev || 1 : 0);
  }

  /* Проверка записи в приложении одна — normalizeRecord в app.js.
     Файлы подключены обычными скриптами, поэтому она доступна глобально. */
  function adopt(raw) {
    if (typeof normalizeRecord === 'function') return normalizeRecord(raw);
    return raw && raw.id ? raw : null;
  }

  /**
   * Применяет одну запись с сервера. Возвращает true, если учёт изменился
   * и нужно перерисовать интерфейс.
   */
  function applyRemote(incoming) {
    if (merge(knownRev(incoming.id), incoming.rev) === 'keep') return false;

    if (incoming.deleted) {
      state.transactions = state.transactions.filter((t) => t.id !== incoming.id);
      graves.set(incoming.id, { ...incoming, deleted: 1 });
      return true;
    }

    /* Сервер — тоже клиент: доверяем ему ровно настолько, насколько
       доверяем себе. Нормализация отбросит мусор и починит расхождения,
       поэтому учёт на всех устройствах останется одинаковым. */
    const record = adopt(incoming);
    if (!record) {
      /* Негодная запись не должна возвращаться при каждом обмене:
         закрываем её у себя, чтобы сервер её не присылал снова. */
      graves.set(incoming.id, { ...incoming, deleted: 1 });
      pending.add(incoming.id);
      return true;
    }

    const index = state.transactions.findIndex((t) => t.id === incoming.id);
    if (index === -1) state.transactions.push(record);
    else state.transactions[index] = record;

    graves.delete(incoming.id);
    return true;
  }

  /** Записи, которые сервер ещё не видел. */
  function outgoing() {
    const list = [];
    for (const id of pending) {
      const live = state.transactions.find((t) => t.id === id);
      if (live) list.push({ ...live, deleted: 0 });
      else if (graves.has(id)) list.push(graves.get(id));
    }
    return list;
  }

  /* ---------- шаги обмена ---------- */

  async function push() {
    const list = outgoing();
    if (!list.length) return false;

    const result = await api('/api/changes', {
      method: 'POST',
      body: JSON.stringify({ records: list }),
    });

    for (const rec of list) pending.delete(rec.id);
    cursor = Math.max(cursor, Number(result.cursor) || cursor);
    writeJson(CURSOR_KEY, cursor);
    return true;
  }

  /**
   * Забирает изменения с сервера.
   * collect — когда он задан, собираем сведения для первого подключения:
   * что сервер уже знает (seen) и где наша версия новее серверной (ahead).
   */
  async function pull(collect = null) {
    let changed = false;

    for (let page = 0; page < PULL_GUARD; page += 1) {
      const data = await api(`/api/changes?since=${cursor}`);

      for (const change of data.changes || []) {
        const rec = change && change.record;
        if (!rec) continue;

        if (collect) {
          collect.seen.add(rec.id);
          /* Наша запись новее — её надо отправить, а не молча оставить. */
          if (merge(knownRev(rec.id), rec.rev) === 'keep') collect.ahead.add(rec.id);
        }

        if (applyRemote(rec)) changed = true;
      }

      cursor = Math.max(cursor, Number(data.cursor) || cursor);
      writeJson(CURSOR_KEY, cursor);

      if (!data.hasMore) break;
    }

    return changed;
  }

  /* Не даём двум обменам наложиться: они бы затёрли cursor друг друга. */
  function run() {
    if (!config) return Promise.resolve(false);
    if (inFlight) return inFlight;

    inFlight = (async () => {
      let problem = '';
      let changed = false;

      try {
        setStatus('busy');

        /* Неудачная отправка не должна мешать забрать чужие изменения:
           из-за одного непроходящего POST обмен встал бы целиком. */
        try {
          await push();
        } catch (err) {
          problem = err.message || String(err);
        }

        changed = await pull();
        writeGraves();
      } catch (err) {
        problem = problem || (err.message || String(err));
      } finally {
        inFlight = null;
      }

      setStatus(problem ? 'error' : 'on', problem);

      /* Возвращаем именно «изменился ли учёт»: вызывающему нужно это,
         чтобы перерисовать интерфейс. Ошибка уходит отдельно, через статус. */
      return changed;
    })();

    return inFlight;
  }

  function schedulePush() {
    if (!config) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { run(); }, PUSH_DELAY_MS);
  }

  /* ---------- публичный интерфейс ---------- */

  async function boot() {
    config = readJson(CONFIG_KEY, null);
    cursor = Number(readJson(CURSOR_KEY, 0)) || 0;
    graves = readGraves();

    if (config) {
      setStatus('busy');
      /* Сессия могла истечь, пока приложение было закрыто. */
      run();
      pollTimer = setInterval(run, POLL_MS);
    } else {
      setStatus('off');
    }
  }

  async function connect(url, password) {
    const base = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) throw new Error('Нужен адрес, начинающийся с https://');

    setStatus('busy');

    let result;
    try {
      const response = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Сервер ответил ${response.status}`);
      }
      result = await response.json();
    } catch (err) {
      setStatus('error', err.message || String(err));
      throw err;
    }

    /* Первый вход начинаем с нуля: иначе новый пустой cursor притянет
       только своё, а старые записи останутся невычитанными навсегда. */
    config = { url: base, token: result.token, expiresAt: Number(result.expiresAt) || 0 };
    cursor = 0;
    pending = new Set();
    writeJson(CONFIG_KEY, config);
    writeJson(CURSOR_KEY, 0);

    const collect = { seen: new Set(), ahead: new Set() };
    const changed = await pull(collect);

    /* Первый вход: решаем, что уходит на сервер, а что он уже знает.
       Без этого учёт, набранный до подключения, остался бы только здесь,
       а запись, опередившая серверную копию, так и не была бы отправлена. */
    pending = new Set(collect.ahead);
    for (const live of state.transactions) {
      if (!collect.seen.has(live.id)) pending.add(live.id);
    }
    for (const id of graves.keys()) {
      if (!collect.seen.has(id)) pending.add(id);
    }

    /* Подключение состоялось, даже если отправка не прошла: локальный учёт
       уйдёт при следующем обмене, а пользователь увидит причину. */
    try {
      await push();
    } catch (err) {
      setStatus('error', err.message || String(err));
    }

    writeGraves();
    setStatus(status === 'error' ? 'error' : 'on');

    clearInterval(pollTimer);
    pollTimer = setInterval(run, POLL_MS);

    return changed;
  }

  function disconnect() {
    clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(pushTimer);
    pushTimer = null;
    inFlight = null;
    forget();
  }

  function markDirty(ids) {
    for (const id of ids) pending.add(id);
    schedulePush();
  }

  /** Помечает операцию удалённой, чтобы удаление дошло до других устройств. */
  function retire(record) {
    if (!record) return;
    const dead = { ...record, deleted: 1, rev: (record.rev || 1) + 1 };
    graves.set(dead.id, dead);
    pending.add(dead.id);
    writeGraves();
    schedulePush();
  }

  /**
   * Полная замена учёта: «удалить всё» и импорт файла.
   * Если этого не сказать серверу, он на следующем обмене вернёт прежние
   * операции обратно — на этом устройстве удалили, на сервере нет.
   */
  function replaceAll(next) {
    const kept = new Set(next.map((rec) => rec.id));

    /* Всё живое, чего нет в новом учёте, уходит на сервер как удалённое. */
    for (const live of state.transactions) {
      if (!kept.has(live.id)) retire(live);
    }

    /* Уже удалённое переотправляем: прошлая отправка могла не дойти. */
    for (const id of graves.keys()) {
      if (!kept.has(id)) pending.add(id);
    }

    /* Новое помечаем к отправке, и его надгробие снимаем: операция снова жива. */
    for (const rec of next) {
      pending.add(rec.id);
      graves.delete(rec.id);
    }

    writeGraves();
    schedulePush();
  }

  /* Телефон мог уснуть, пока сеть лежала: обновляемся при возврате на экран. */
  function watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && config) run();
    });
  }

  return {
    boot, connect, disconnect, markDirty, retire, replaceAll, onChange, watchVisibility, run,
    isOn: () => !!config,
    status: () => status,
    error: () => lastError,
    configForUi: () => (config ? { url: config.url } : null),
    /* для тестов */
    applyRemote, merge, knownRev, outgoing, pull, push, forget,
    _state: () => ({ cursor, graves, pending, config }),
  };
})();

Sync.watchVisibility();
