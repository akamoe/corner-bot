# Corner Bot - Project Refactor & Optimization Summary

This document summarizes the work performed on the Corner Bot to improve its reliability, performance, and maintainability in a serverless environment (Vercel).

## 🚀 Overview of Work
The project was executed in three main phases, followed by critical bug fixing and stabilization, and a subsequent code quality pass.

---

## 🛠 Phase 1: Immediate Bug Fixes & Optimization

### 1. Fix "Clear Chat" Button
- **Issue:** The "Clear Chat" button was unresponsive.
- **Cause:** Middleware preemption. A global `bot.on('text')` handler was registered *before* the specific `bot.hears('🧹 Clear Chat')` handler, intercepting the message.
- **Fix:** Moved the "Clear Chat" handler above the global text handler.

### 2. Cold-Start Performance Optimization
- **Issue:** High latency on every request.
- **Cause:** `bot.telegram.setMyCommands` was being called on every cold start (every request on Vercel), causing unnecessary API round-trips to Telegram.
- **Fix:** Wrapped command registration into a new, admin-only `/setup_commands` command.

---

## 🏗 Phase 2: Modularization & Architecture

### 1. Separation of Concerns
- **Notifications:** Moved `notifyCashiers` and `notifyStudent` from the 2,300+ line `api/webhook.js` to a dedicated `lib/notifications.js`.
- **Admin Commands:** Extracted initial admin setup commands into `lib/admin-commands.js`.

### 2. Role-Based Access Control (RBAC)
- **Issue:** Manual authorization checks (`getStaffRole`) were duplicated in every handler.
- **Fix:** Created `lib/middleware.js` with `requireAdmin` and `requireStaff` middleware to centralize security logic.

---

## 💾 Phase 3: Persistent State Management (Critical)

### 1. Serverless "Memory" Fix
- **Issue:** Admins and Students would randomly lose their progress in multi-step flows (e.g., adding an item or customizing a meal).
- **Cause:** State was stored in local in-memory `Map` objects. In Vercel's serverless environment, memory is wiped whenever the function "sleeps" (cold starts).
- **Fix:** 
    - Created a `bot_state` table in Supabase.
    - Rewrote `lib/state.js` to use asynchronous database calls instead of local memory.
    - Updated over 70+ handlers to `await` state retrieval and persistence.

---

## 🐞 Critical Bug Fixes & Stabilization

### 1. State Mutation Persistence
- **Issue:** Customization flow (toppings/quantity) was still not saving.
- **Cause:** Code was mutating local copies of the state fetched from the DB but never calling `.set()` to save them back.
- **Fix:** Added explicit `await orderFlowState.set()` calls in all mutation handlers.

### 2. Supabase Connection Error (PGRST125)
- **Issue:** All database operations on the new `bot_state` table failed.
- **Cause:** The `SUPABASE_URL` in `.env` included a trailing `/rest/v1/` path, which broke the Supabase client's path generation for specific operations.
- **Fix:** Updated `lib/supabase.js` to sanitize and strip trailing paths from the URL.

### 3. Telegram Markdown Resiliency
- **Issue:** "View Orders" and "Customize Meal" would crash with "Oops, something went wrong."
- **Cause:** Telegram's Markdown parser is fragile; special characters (like `_`, `*`, `[`) in database data (item names, tokens) caused fatal API errors.
- **Fix:** Implemented a robust `try/catch` wrapper with a plain-text fallback. If Markdown parsing fails, the bot automatically strips special characters and resends the message as plain text.

---

## 🔮 Future Recommendations

1. **Complete Modularization:** There are still ~2,000 lines in `api/webhook.js`. Continue moving `bot.action` and `bot.on('text')` handlers into domain-specific files (e.g., `lib/handlers/orders.js`).
2. **Internationalization (I18n):** Centralize all Arabic and English strings into a `lib/i18n.js` dictionary to ensure UI consistency and make text updates easier.
3. **Database Cleanup Task:** Implement a scheduled task (Supabase Edge Function) to delete old records from the `bot_state` table to keep it lean.
4. **Enhanced RBAC:** Migrate the remaining 70 manual role checks to the new middleware as refactoring continues.

## ✅ Code Quality Pass (April 2025)

### 6 files optimized across 10 improvements:

| File | Change |
|------|--------|
| `lib/cart.js` | Consolidated duplicate `removeItemFromCart`/`removeItemFromCartById` into one |
| `lib/state.js` | Cleaned variable naming in `deleteState` for consistency |
| `lib/notifications.js` | Skip DB refetch when order details already in memory (avoids unnecessary query per new order) |
| `lib/slots.js` | Replaced N+1 per-slot count queries with single batched query (count in `Map` in memory) |
| `lib/admin-commands.js` | Fixed escaped string literals, re-added `/addcashier` handler |
| `api/webhook.js` | Removed unused `order` param from `formatOrderSummary`, broadcast now sends 20 concurrent messages via `Promise.allSettled`, `remove_` regex tightened to UUID-only, removed legacy `add_` handler |

## 📂 Modularization (April 2025)

**webhook.js reduced from 2,250 → 550 lines.** Split into 10 domain handler files:

```
api/webhook.js                        → 550 lines (imports + setup + /start + commands + text handler + export)
lib/handlers/
  admin-orders.js                     → View Orders, Analytics, Total Sales
  admin-menu.js                       → Category/Item CRUD, Toppings/Groups, Assignments
  admin-staff.js                      → Add/Remove/List cashiers
  admin-slots.js                      → Slot management
  admin-broadcast.js                  → Broadcast flow
  student-menu.js                     → Browse menu, customization flow, toppings toggles
  student-cart.js                     → Cart display, qty controls, confirm order
  student-orders.js                   → My Orders display
  cashier-orders.js                   → Active orders, status transitions, order lookup
  toppings-groups-manage.js           → Edit toppings and groups admin panel
  helpers.js                          → Shared utility functions
```

Each file exports a `setup*` function that takes the `bot` instance and registers its own handlers. Registration order is preserved to ensure specific handlers fire before the catch-all `bot.on('text')`.

`showOrdersForDay` and `showAnalytics` were moved to module-level scope so the text handler (in webhook.js) can call them directly.

---

## 🔐 RLS Policy Fix & Error Handling Overhaul (May 2026)

### 1. Database RLS Cleanup Broke the Bot
- **Issue:** After dropping 15 wide-open anonymous policies (May 8 RLS cleanup), every bot database operation silently failed. The `users` SELECT returned 0 rows, all INSERT/UPDATE/DELETE were blocked.
- **Root cause:** `lib/supabase.js` was initialized with `SUPABASE_ANON_KEY` (the public client key), which is subject to RLS. The bot is a server-side service (Vercel) and should use the `service_role` key to bypass RLS.
- **Fix:** Changed `lib/supabase.js` line 7 from `SUPABASE_ANON_KEY` to `SUPABASE_SERVICE_ROLE_KEY`. The key was already in `.env` but was never wired up.
- **Lesson:** Service-side scripts that need full DB access must use `service_role` key. The `anon` key is only appropriate for client-side code (browser/mobile) where RLS enforces per-user access.

### 2. Error Logging Made Debuggable
- **Issue:** All 50+ `console.error` calls in the bot only logged `error.message` with no context about which function failed or what parameters it was called with.
- **Fix:** Every `console.error` now includes:
  - A `[functionName]` tag for grep-ability
  - Relevant context IDs (userId, orderId, itemId, cartId, etc.)
  - The full error object (so stack traces appear in Vercel logs)
- **Files affected:** `lib/menu.js`, `lib/cart.js`, `lib/orders.js`, `lib/slots.js`, `lib/toppings.js`, `lib/auth.js`, `lib/state.js`, `lib/notifications.js`, `api/webhook.js`, `lib/handlers/admin-orders.js`, `lib/handlers/admin-menu.js`, `lib/handlers/student-cart.js`, `lib/handlers/student-menu.js`, `lib/handlers/student-orders.js`

### 3. Global Error Handler Improved
- **Before:** Generic "Oops, something went wrong" in English, no context logged.
- **After:** Logs `userId`, `chatId`, and full stack trace. Replies in Arabic with a message advising the user to contact support if the issue persists.

### 4. New try/catch Paths Added
- `clear_cart` handler (student-cart.js): Was missing error handling entirely — would crash the bot on Supabase failure.
- `deleteState` DB operations (state.js): Both `DELETE` and `upsert` branches weren't checking for errors.
- `notifyCashiers` order details fetch (notifications.js): Secondary query for order details wasn't error-checked.
