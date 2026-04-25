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
