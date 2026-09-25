# Wayl in the Telegram bot: approval review

Status: proposal. No migration was applied. No payment link or customer order was created.

## Integration path

Telegram `sendInvoice` needs a provider token issued through BotFather. Telegram describes provider onboarding through `@BotSupport`; the public docs do not show that Wayl is onboarded. We have no Wayl BotFather token or proof that one can be issued. Use a Wayl payment link in the chat, with a signed webhook to confirm payment. Do not treat the browser return as payment proof.

Sources: [Telegram payments](https://core.telegram.org/bots/payments), [Wayl guide](https://wayl.io/docs), [Wayl OpenAPI](https://api.thewayl.com/openapi.v1.json).

## Database choice

Use a new `public.telegram_wayl_payments` table linked to `public.users.id` and the bot's pending basket in `public.orders.id`. Do not use `public.web_payments`: its `auth_id` is required and refers to `auth.users`, while most Telegram users have no website sign-in. The website and bot have separate code but share this production database.

| Choice | Benefit | Cost or risk |
| --- | --- | --- |
| Make `web_payments.auth_id` nullable and add Telegram owner fields | One payment table | Changes the website's owner rules, constraints, RPCs, and security checks. Both apps must change together. |
| Create website Auth users for Telegram customers | Reuses website RPCs | Adds artificial sign-ins, identity linking, and account lifecycle work. |
| Separate Telegram payment table (proposed) | Keeps website payment identity unchanged; bot owner is explicit | Adds bot-specific table, RPCs, and triggers on shared order tables. |

## Exact SQL and rollback

- [Proposed production migration](PROPOSED_telegram_wayl_checkout.sql)
- [Proposed rollback before any payment row exists](PROPOSED_rollback.sql)

Both files are review artifacts. Do not run them without explicit approval. If any payment row exists, the rollback stops before it drops anything. Keep paid history and prepare a data-preserving repair or a backup restore instead.

The migration runs in one transaction. It creates one table, two indexes, two guard triggers, and five payment functions. It does not change `web_payments`, website payment functions, Auth tables, or existing rows. The item trigger locks each parent order on item edits. That lock also affects website item writes, so test for added contention before release. The order trigger prevents direct changes to a basket with an open bot checkout. Service-role access is limited by server-side owner, basket, amount, and state checks in the functions; RLS bypass alone is not treated as authorization.

## Required bot behavior after approval

1. Show the selected slot, basket total, and a choice between cash and Wayl. In `WAYL_ENV=test`, mark the Wayl option clearly as a test and do not send a kitchen order.
2. Call `create_telegram_wayl_checkout` using the server-resolved bot user and cart IDs. Repeated taps reuse the same open checkout for the same basket and slot. A different basket with the same request ID fails.
3. Create one Wayl link with `env`, `referenceId`, `total`, `currency: IQD`, a matching `lineItem`, `webhookUrl`, `webhookSecret`, and `redirectionUrl`. The live API requires the three URL/secret strings even though the OpenAPI flags are less strict. Store and send the URL only if its HTTPS host is exactly `checkout.thewayl.com`.
4. Set a 15-minute link lifetime. Recover a timed-out create by reading the same Wayl reference before any retry. Never create a second charge path for one payment row.
5. Use a Vercel Web Request webhook route. Read at most 64 KiB of raw bytes, verify `x-wayl-signature-256` with constant-time HMAC-SHA256, then parse JSON. Read the link again from Wayl by reference and compare reference, amount, and IQD currency with the database row. Ignore callback status and browser redirect as payment proof.
6. Map Wayl `Complete` and `Delivered` to paid; `Returned` to refunded; `Cancelled` and `Rejected` to cancelled; `Created`, `Pending`, and `Processing` to open. Keep unknown states unchanged. The RPCs make duplicate and stale callbacks idempotent.
7. A live paid callback changes the reserved basket from `pending` to `confirmed` in one transaction, then notifies the customer and staff. A test paid callback changes only payment state and gives a clear test result. A refund changes only payment state and calls for staff review.
8. Reconcile open links by Wayl reference when the customer checks status and in a scheduled bot job. Release a slot only after Wayl confirms a terminal unpaid state or the link has been invalidated at Wayl. Do not release on a local timer alone.
9. Store `WAYL_API_KEY`, `WAYL_WEBHOOK_SECRET`, `WAYL_ENV`, and `WAYL_SITE_URL` in the bot environment only. Missing or invalid values hide the Wayl option and reject callbacks. The return page can tell the customer that confirmation is pending and send them back to the bot; it must not say payment succeeded.

## Purchase journey review: proposals only

No buying journey change has been made. These changes need separate approval.

| Finding | Evidence in bot | Proposed change |
| --- | --- | --- |
| A quantity button can affect another person's item if its ID is known or a message is shared | `lib/cart.js` updates by item ID without checking owner; `student-cart.js` quantity handlers pass no owner | Require `user_id` and `pending` basket ownership for every item update and delete, with an atomic database write. |
| Capacity read failure can allow overselling | `lib/orders.js` returns `true` when the count query fails | Fail closed and show a retry message. Use the slot lock used by payment checkout. |
| A database read error appears as an empty basket or no available slots | `getCart`, `getAvailableSlots`, and order-list helpers return `null` or `[]` on query error | Distinguish empty data from query failure and show an Arabic retry message. |
| Repeated taps can lose UI or flow state | `lib/state.js` reads and upserts one JSON `bot_state` document, without an atomic merge | Use a database patch RPC or version check for the changed state key. |
| A menu price or availability can change after an item screen opens | `student-menu.js` adds the price saved in `orderFlowState`, without a fresh menu read | Recheck the item, topping choices, and price when adding it to the basket; show the new price before checkout. |
| Two first adds can create two pending baskets; the next cart read can fail | `getOrCreateCart()` reads then inserts, and `getCart()` expects one row | Add one-active-basket protection and a safe retry for a concurrent first add. |
| A note prompt can stay active after the customer taps back to the basket | `cart_note` sets `awaiting_cart_note`; `view_cart` does not clear it | Clear note state on back, and add a cancel action in the note prompt. |
| Cart summary and item controls span several messages; deletion and edit errors are often ignored | `showCart`, `forgetMessages`, `refreshSummary`, `safeReply`, `safeEdit` | Keep a single clear summary, show a refresh action, and report an edit or delete failure instead of leaving stale buttons. |
| Checkout confirms immediately when a slot is tapped | `slot_...` calls `confirmOrder` and notifies staff | Add an explicit payment choice and final summary. Confirm Wayl orders only on verified capture. |
| `/menu` adds a step | `lib/bot.js` only tells the customer to press the menu keyboard button | Open the categories directly. |
| Customization cancellation returns to category root, and page arrows have no text label | `student-menu.js` cancel and page buttons | Return to the current category and label controls in Arabic, such as previous and next. |
| Help copy has no payment or support path | `helpText()` in `lib/bot.js` | Explain cash versus Wayl, test mode, pending payment, and how to contact staff. |
| A newer order can hide an older active order, and cancellation can race with staff action | `getOrdersForUser()` limits to five before `showMyOrders()` filters; `cancelOrderByStudent()` checks status before an unconditional update | Fetch all active orders separately; cancel only with an atomic `status = confirmed` condition. |
| A staff message can fail while the customer sees a confirmed order | `notifyCashiers()` logs send errors and returns | Add a durable notification retry record and a staff-visible alert for repeated failure. |

The current flow already shows topping prices, required topping groups, quantity, basket total, and remaining slot places. Keep those clear parts. Review the final Arabic copy with a local reader before release.

## Test gate

Run pure unit and fake-database tests first: forged signature, wrong secret, tampered raw body, body size, amount and currency mismatch, duplicate and out-of-order callbacks, unknown reference, owner mismatch, and test-mode isolation. No test may call live Wayl charge or send real staff notifications. After migration approval, use one clearly named disposable test identity, record counts for `users`, `orders`, `order_items`, `bot_state`, and `telegram_wayl_payments` before and after, remove the test rows, and require exact count parity. Keep `WAYL_ENV=test` throughout. This test plan is pending approval because the shared database is production.

Read-only production counts during this proposal (two reads, no writes):

| Table or check | Before | After |
| --- | ---: | ---: |
| `users` | 16 | 16 |
| `users` with `auth_id IS NULL` | 14 | 14 |
| `orders` | 75 | 75 |
| `order_items` | 117 | 117 |
| `bot_state` | 0 | 0 |
| `web_payments` | 0 | 0 |

No disposable identity was created at this stage. The proposed table does not exist, and the database test is still pending approval.
