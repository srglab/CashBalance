-- Схема синхронизации для Cloudflare D1 (SQLite).
-- Применяется один раз: wrangler d1 execute cashbalance --file=worker/schema.sql --remote

-- Текущее состояние всех операций. По одной строке на операцию,
-- независимо от того, сколько раз она повторяется.
CREATE TABLE IF NOT EXISTS tx (
  id           TEXT    PRIMARY KEY,
  type         TEXT    NOT NULL,
  amount       REAL    NOT NULL,
  category     TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT '',
  start        TEXT    NOT NULL,
  repeat       TEXT    NOT NULL DEFAULT 'none',
  repeat_every INTEGER NOT NULL DEFAULT 1,
  weekdays     TEXT    NOT NULL DEFAULT '[]',
  end_at       TEXT,
  -- rev растёт при каждом изменении операции на любом устройстве.
  -- Именно он, а не время, определяет победителя при конфликте:
  -- часы на устройствах могут врать, счётчик — нет.
  rev          INTEGER NOT NULL DEFAULT 1,
  -- Мягкое удаление: иначе удаление на телефоне не дойдёт до компьютера.
  deleted      INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

-- Журнал изменений. AUTOINCREMENT даёт сквозной порядок, по которому
-- устройства вычитывают только новое с тех пор, как видели.
CREATE TABLE IF NOT EXISTS changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT    NOT NULL,
  rev     INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  -- Полная операция в JSON: журнал не зависит от дальнейших изменений tx.
  data    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS changes_id ON changes (id);
