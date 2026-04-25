# Skill: Telegram Bot Optimization for Serverless Environments

Expert guidance for optimizing Node.js Telegram bots (Telegraf) running on serverless platforms like Vercel or AWS Lambda, specifically when integrated with Supabase.

## 🧠 Knowledge & Lessons Learned

### 1. The State Persistence Trap
*   **Fact:** In-memory objects (`Map`, `Set`, variables) are **volatile** in serverless functions. They are wiped on every "cold start" (when the function scales to zero).
*   **Lesson:** For multi-step conversational flows, **never** rely on local memory. Always persist state (e.g., `adminFlowState`) to a database (Supabase/Redis) using the user's Telegram ID as the primary key.
*   **Gotcha:** When moving to a DB-backed state, remember that `state.get()` returns a *copy*. If you mutate the object, you **must** call `state.set()` to persist the changes.

### 2. Middleware Registration Order
*   **Fact:** Telegraf (and similar frameworks) execute handlers in the order they are registered.
*   **Lesson:** Register specific commands (`bot.command`, `bot.hears`) **before** general catch-all handlers (`bot.on('text')`). If the general handler is registered first and doesn't call `next()`, your specific commands will be "shadowed" and never trigger.

### 3. Telegram API Performance
*   **Fact:** Network calls to the Telegram Bot API add latency.
*   **Lesson:** Minimize operations that run on every request. For example, move `bot.telegram.setMyCommands` to a dedicated administrative trigger rather than running it inside the main webhook entry point.

### 4. Robust Messaging (Markdown)
*   **Fact:** Telegram's `Markdown` and `MarkdownV2` parsers are extremely fragile. Unescaped special characters (e.g., `_`, `*`, `[`, `]`) in user-generated or database-fetched content will cause the API call to fail.
*   **Lesson:** Always wrap `ctx.reply` or `ctx.editMessageText` calls that use Markdown in a `try/catch` block. Provide a fallback that strips formatting and sends plain text to ensure the bot doesn't "hang" on a crash.

### 5. Supabase Client Configuration
*   **Fact:** Environment variables for `SUPABASE_URL` sometimes include API paths (like `/rest/v1/`).
*   **Lesson:** Ensure the `supabase-js` client is initialized with the base project URL only. Adding trailing paths manually or via `.env` can cause `PGRST125` (Invalid path) errors.

### 6. N+1 Query Avoidance for Slots
*   **Fact:** When showing available pickup slots, the naive approach is 1 query for slots + N queries to count orders per slot.
*   **Lesson:** Fetch all today's non-cancelled orders in a single query (no count, no `head:true`), then group/count by `slot_id` in-memory using a `Map`. This replaces N queries with 1.

### 7. Batch Concurrent Sending
*   **Fact:** Sending messages to many users in a `for` loop is slow (sequential) and can hit Telegram rate limits.
*   **Lesson:** Use batched `Promise.allSettled` with a concurrency limit (e.g., 20) instead. Catches individual send failures without crashing the whole batch.

### 8. Avoid Duplicate DB Fetches
*   **Fact:** `notifyCashiers` was called with the full `order` object already containing items and slot info.
*   **Lesson:** Before querying the DB, check if the data is already available on the passed object. Only fetch if `order.order_items` or `order.pickup_slots` is missing.

### 9. Keep `getStaffRole` Inline (Don't Migrate to Middleware)
*   **Fact:** The SUMMARY.md recommended migrating all role checks to the `requireAdmin`/`requireStaff` middleware.
*   **Reality:** Inline `getStaffRole` checks work reliably. Migrating 70+ handlers to middleware changes the order in which handlers are registered, which can break things silently. The middleware pattern is fine for `bot.hears` or `bot.command` handlers, but `bot.action` handlers with inline checks are more predictable.
*   **Lesson:** Don't fix what isn't broken. The inline role check pattern is explicit and easy to trace in the text handler.

### 10. Regex Tightness for Callback Data
*   **Fact:** Loose regex patterns like `/^remove_(.+)$/` can match callback data from unrelated features.
*   **Lesson:** Use UUID-specific patterns (e.g., `/^remove_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/`) when matching callback data containing IDs.

### 11. Patching JavaScript with `\n`
*   **Fact:** The `patch` tool in Hermes may write literal `\\n` (backslash + n characters) instead of actual newlines when used inside JS string literals.
*   **Lesson:** After patching `.js` files containing `\n` in template literals or strings, verify with `node --input-type=module -e "import('./file.js')"` and check for `SyntaxError`. If broken, use a small Python script with `bytes.replace()` to fix the literal escape sequences.

## 🛠 Useful Patterns

### Persistence Wrapper Pattern
```javascript
export const botState = {
  get: async (id) => { /* fetch from DB */ },
  set: async (id, val) => { /* upsert to DB */ },
  delete: async (id) => { /* remove from DB */ }
}
```

### Markdown Fallback Pattern
```javascript
try {
  await ctx.reply(richText, { parse_mode: 'Markdown' });
} catch (err) {
  // Strip special chars and retry as plain text
  await ctx.reply(richText.replace(/[*_`\[\]]/g, ''));
}
```

### Batched Concurrent Send Pattern
```javascript
const CONCURRENCY = 20
for (let i = 0; i < users.length; i += CONCURRENCY) {
  const batch = users.slice(i, i + CONCURRENCY)
  const outcomes = await Promise.allSettled(
    batch.map(u => bot.telegram.sendMessage(u.telegram_id, message)
      .catch(() => { failed++; return null })
    )
  )
  sent += outcomes.filter(o => o.status === 'fulfilled' && o.value !== null).length
}
```

### N+1 → Single Query for Slot Availability
```javascript
// Instead of: slots.map(s => supabase.from('orders').select('*', { count: 'exact', head: true }).eq('slot_id', s.id))
const { data: orders } = await supabase
  .from('orders')
  .select('slot_id')
  .neq('status', 'cancelled')
  .gte('created_at', `${today}T00:00:00`)
  .lte('created_at', `${today}T23:59:59`)

const countBySlot = new Map()
for (const o of orders || []) {
  countBySlot.set(o.slot_id, (countBySlot.get(o.slot_id) || 0) + 1)
}
// Now map slots with countBySlot.get(slot.id) || 0
```
