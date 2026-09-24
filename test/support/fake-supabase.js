/**
 * In-memory stand-in for the Supabase client, shaped like PostgREST.
 *
 * Only the query surface the bot uses is implemented, but it is implemented
 * honestly:
 *   - filters (eq/neq/in/is/gte/lte/lt) with timestamp-aware comparison
 *   - ordering, limit, `count: 'exact', head: true`
 *   - embedded selects, including nesting: '*, order_items(*, menu_items(*))'
 *   - upsert conflict targets (PostgREST defaults to the PK, and bot_state's PK
 *     is user_id — guessing "id" breaks it)
 *   - the 23505 unique-violation error the order-code retry logic depends on
 */

import crypto from 'crypto'

const UNIQUE = {
  orders: ['order_code'],
  users: ['telegram_hash'],
  staff: ['telegram_hash'],
  bot_state: ['user_id']
}

/** How embedded resources resolve to each other. */
const RELATIONS = {
  orders: {
    order_items: { type: 'has_many', fk: 'order_id' },
    pickup_slots: { type: 'belongs_to', fk: 'slot_id' },
    users: { type: 'belongs_to', fk: 'user_id' }
  },
  order_items: {
    menu_items: { type: 'belongs_to', fk: 'menu_item_id' }
  },
  item_topping_groups: {
    topping_groups: { type: 'belongs_to', fk: 'group_id' }
  },
  topping_group_options: {
    toppings: { type: 'belongs_to', fk: 'topping_id' }
  }
}

const error = (message, code) => ({ message, code, details: null, hint: null })

/**
 * Postgres compares timestamptz as instants; naive string comparison would say
 * '2026-05-09T00:00:00+03:00' < '2026-05-08T22:00:00Z'. Compare parseable
 * timestamps as instants and fall back to strings otherwise.
 */
function compare(a, b) {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb
  if (a === b) return 0
  return a > b ? 1 : -1
}

/** Split a select list on TOP-LEVEL commas: 'a, b(c, d)' -> ['a', 'b(c, d)'] */
function splitTopLevel(columns) {
  const parts = []
  let depth = 0
  let buf = ''

  for (const ch of String(columns ?? '')) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** { scalars: [...], embeds: [{ name, columns, embeds }] } */
function parseSelect(columns) {
  const scalars = []
  const embeds = []

  for (const part of splitTopLevel(columns)) {
    const open = part.indexOf('(')
    if (open === -1) {
      scalars.push(part)
      continue
    }
    const name = part.slice(0, open).trim()
    const inner = part.slice(open + 1, part.lastIndexOf(')')).trim()
    embeds.push({ name, columns: inner, embeds: parseSelect(inner).embeds })
  }

  return { scalars, embeds }
}

function embeddedSelect(embed) {
  return {
    scalars: splitTopLevel(embed.columns).filter((c) => !c.includes('(')),
    embeds: embed.embeds
  }
}

function applyColumns(row, columns) {
  const out = {}
  for (const raw of columns) {
    const col = String(raw).trim()
    if (col.includes(':')) {
      const [alias, real] = col.split(':').map((x) => x.trim())
      out[alias] = row[real]
    } else {
      out[col] = row[col]
    }
  }
  return out
}

export function createFakeSupabase(seed = {}) {
  const tables = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }

  const table = (name) => {
    if (!tables[name]) tables[name] = []
    return tables[name]
  }

  function resolveEmbed(baseTable, row, embed) {
    const rel = RELATIONS[baseTable]?.[embed.name]
    if (!rel) return undefined

    const select = embeddedSelect(embed)

    if (rel.type === 'belongs_to') {
      const fk = row[rel.fk]
      if (!fk) return null
      const found = table(embed.name).find((r) => r.id === fk)
      return found ? project(embed.name, found, select) : null
    }

    return table(embed.name)
      .filter((r) => r[rel.fk] === row.id)
      .map((r) => project(embed.name, r, select))
  }

  function project(baseTable, row, select) {
    // A bare `*` means "all columns", even next to embeds like
    // '*, order_items(*)'. Getting that wrong silently drops every column.
    const out = select.scalars.includes('*') ? { ...row } : applyColumns(row, select.scalars)

    for (const embed of select.embeds) {
      out[embed.name] = resolveEmbed(baseTable, row, embed)
    }
    return out
  }

  function checkUnique(name, candidate, ignoreRowId) {
    for (const row of table(name)) {
      if (ignoreRowId && row.id === ignoreRowId) continue
      for (const key of UNIQUE[name] || []) {
        if (candidate[key] != null && row[key] === candidate[key]) {
          return `duplicate key value violates unique constraint "${name}_${key}_key"`
        }
      }
    }
    return null
  }

  function builder(name) {
    const state = {
      action: 'select',
      payload: null,
      columns: '*',
      filters: [],
      order: [],
      limit: null,
      mode: null,
      returning: false,
      countRequested: false,
      head: false,
      onConflict: null
    }

    const api = {
      select(columns = '*', options = {}) {
        if (state.action === 'select') {
          state.columns = columns
          state.countRequested = Boolean(options?.count)
          state.head = Boolean(options?.head)
        } else {
          state.returning = true
          state.columns = columns
        }
        return api
      },
      insert(payload) {
        state.action = 'insert'
        state.payload = payload
        return api
      },
      update(payload) {
        state.action = 'update'
        state.payload = payload
        return api
      },
      upsert(payload, options = {}) {
        state.action = 'upsert'
        state.payload = payload
        state.onConflict = options.onConflict || null
        return api
      },
      delete(options = {}) {
        state.action = 'delete'
        state.countRequested = Boolean(options?.count)
        return api
      },
      eq(col, value) {
        state.filters.push((row) => row[col] === value)
        return api
      },
      neq(col, value) {
        state.filters.push((row) => row[col] !== value)
        return api
      },
      in(col, values) {
        state.filters.push((row) => values.includes(row[col]))
        return api
      },
      is(col, value) {
        state.filters.push((row) => row[col] === value || (row[col] === undefined && value === null))
        return api
      },
      gte(col, value) {
        state.filters.push((row) => row[col] != null && compare(row[col], value) >= 0)
        return api
      },
      lte(col, value) {
        state.filters.push((row) => row[col] != null && compare(row[col], value) <= 0)
        return api
      },
      lt(col, value) {
        state.filters.push((row) => row[col] != null && compare(row[col], value) < 0)
        return api
      },
      order(col, options = {}) {
        state.order.push({ col, ascending: options.ascending !== false })
        return api
      },
      limit(n) {
        state.limit = n
        return api
      },
      range() {
        return api
      },
      single() {
        state.mode = 'single'
        return api
      },
      maybeSingle() {
        state.mode = 'maybeSingle'
        return api
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject)
      }
    }

    const matching = () => table(name).filter((row) => state.filters.every((fn) => fn(row)))

    function sorted(rows) {
      const out = [...rows]
      for (const { col, ascending } of [...state.order].reverse()) {
        out.sort((a, b) => {
          const cmp = compare(a[col], b[col])
          return ascending ? cmp : -cmp
        })
      }
      return state.limit != null ? out.slice(0, state.limit) : out
    }

    function finish(rows) {
      const select = parseSelect(state.columns)

      if (state.head) return { data: null, error: null, count: rows.length }

      const projected = rows.map((row) => project(name, row, select))

      if (state.mode === 'single') {
        if (projected.length !== 1) {
          return {
            data: null,
            error: error('JSON object requested, multiple (or no) rows returned', 'PGRST116'),
            count: rows.length
          }
        }
        return { data: projected[0], error: null, count: rows.length }
      }
      if (state.mode === 'maybeSingle') {
        return { data: projected[0] ?? null, error: null, count: rows.length }
      }
      return { data: projected, error: null, count: state.countRequested ? rows.length : null }
    }

    /**
     * Which columns identify an existing row for an upsert.
     * Never use the id we generated ourselves — that is exactly how the
     * bot_state upsert (PK = user_id) silently became an insert.
     */
    function conflictKeys(payload) {
      if (state.onConflict && state.onConflict !== 'id') return [state.onConflict]
      const keys = []
      if (payload.id != null) keys.push('id')
      for (const key of UNIQUE[name] || []) {
        if (payload[key] != null) keys.push(key)
      }
      return keys
    }

    function execute() {
      const rows = table(name)

      if (state.action === 'select') return finish(sorted(matching()))

      if (state.action === 'insert' || state.action === 'upsert') {
        const incoming = Array.isArray(state.payload) ? state.payload : [state.payload]
        const created = []

        for (const item of incoming) {
          const candidate = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...item }

          if (state.action === 'upsert') {
            const keys = conflictKeys(item)
            const existing = keys.length ? rows.find((r) => keys.every((k) => r[k] === candidate[k])) : null

            if (existing) {
              const conflict = checkUnique(name, candidate, existing.id)
              if (conflict) return { data: null, error: error(conflict, '23505') }
              Object.assign(existing, candidate, { id: existing.id })
              created.push(existing)
              continue
            }
          }

          const conflict = checkUnique(name, candidate)
          if (conflict) return { data: null, error: error(conflict, '23505') }

          rows.push(candidate)
          created.push(candidate)
        }

        return state.returning ? finish(created) : { data: null, error: null, count: created.length }
      }

      if (state.action === 'update') {
        const targets = matching()
        for (const row of targets) {
          const conflict = checkUnique(name, { ...row, ...state.payload }, row.id)
          if (conflict) return { data: null, error: error(conflict, '23505') }
          Object.assign(row, state.payload)
        }
        return state.returning ? finish(targets) : { data: null, error: null, count: targets.length }
      }

      if (state.action === 'delete') {
        const doomed = matching()
        tables[name] = rows.filter((row) => !doomed.includes(row))
        return { data: null, error: null, count: doomed.length }
      }

      return { data: null, error: error(`unsupported action ${state.action}`), count: null }
    }

    return api
  }

  return {
    from: builder,
    tables,
    /** test helper: live snapshot of a table */
    rows: (name) => table(name)
  }
}
