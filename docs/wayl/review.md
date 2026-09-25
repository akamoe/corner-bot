# Wayl in the Telegram bot: implementation and purchase review

Status: the user approved the migration and all purchase-flow changes. The
`20260925_telegram_wayl_checkout.sql` migration, the approved
`20260925180500_telegram_wayl_order_code_fix.sql` repair, and
`20260925182500_telegram_cash_staff_notices.sql` were applied on
2026-09-25 to production project `halujssasooosxyjruhg`. No Wayl link, real customer order,
charge, or staff message was created during testing. No code was deployed.

## Integration path

Telegram `sendInvoice` needs a provider token issued through BotFather. Telegram describes provider onboarding through `@BotSupport`; the public docs do not show that Wayl is onboarded. We have no Wayl BotFather token or proof that one can be issued. Use a Wayl payment link in the chat, with a signed webhook to confirm payment. Do not treat the browser return as payment proof.

Sources: [Telegram payments](https://core.telegram.org/bots/payments), [Wayl guide](https://wayl.io/docs), [Wayl OpenAPI](https://api.thewayl.com/openapi.v1.json).

## Database choice

Use a new `public.telegram_wayl_payments` table linked to `public.users.id` and the bot's pending basket in `public.orders.id`. Do not use `public.web_payments`: its `auth_id` is required and refers to `auth.users`, while most Telegram users have no website sign-in. The website and bot have separate code but share this production database.

| Choice | Benefit | Cost or risk |
| --- | --- | --- |
| Make `web_payments.auth_id` nullable and add Telegram owner fields | One payment table | Changes the website's owner rules, constraints, RPCs, and security checks. Both apps must change together. |
| Create website Auth users for Telegram customers | Reuses website RPCs | Adds artificial sign-ins, identity linking, and account lifecycle work. |
| Separate Telegram payment table (chosen) | Keeps website payment identity unchanged; bot owner is explicit | Adds bot-specific table, RPCs, and triggers on shared order tables. |

## Exact SQL and rollback

- [Applied production migration](../../supabase/migrations/20260925_telegram_wayl_checkout.sql)
- [Reviewed SQL copy](PROPOSED_telegram_wayl_checkout.sql)
- [Applied order-code repair](../../supabase/migrations/20260925180500_telegram_wayl_order_code_fix.sql)
- [Reviewed repair SQL copy](PROPOSED_fix_order_code.sql)
- [Applied cash notice migration](../../supabase/migrations/20260925182500_telegram_cash_staff_notices.sql)
- [Cash notice rollback](PROPOSED_cash_staff_notices_rollback.sql)
- [Rollback before any payment row exists](PROPOSED_rollback.sql)

Each migration and its reviewed SQL copy were identical when applied. The
rollbacks have not been run. Run the cash notice rollback before the payment
rollback. Each stops if its table has any rows.
Keep paid history and prepare a data-preserving repair or a backup restore
instead.

The repair was needed because production `orders.order_code` is NOT NULL and a
new pending basket already has a code. The first migration tried to clear that
code when a live unpaid link was cancelled or refunded. The repair keeps the
code and clears only the reserved slot and amount. It replaces two functions,
changes no rows, and leaves website payment objects untouched. If payment rows
remain at zero, the full rollback can remove both functions and the Telegram
payment table. Once payment history exists, preserve it and use a reviewed
forward repair instead of dropping it.

The migration runs in one transaction. It creates one table, two indexes, two guard triggers, five payment functions, and one atomic bot-cart function. It does not change `web_payments`, website payment functions, Auth tables, or existing rows. The item trigger locks each parent order on item edits. That lock also affects website item writes, so test for added contention before release. The order trigger prevents direct changes to a basket with an open bot checkout. Service-role access is limited by server-side owner, basket, amount, and state checks in the functions; RLS bypass alone is not treated as authorization.

## Bot behavior

1. Show the selected slot, basket total, and a choice between cash and Wayl. In `WAYL_ENV=test`, mark the Wayl option clearly as a test and do not send a kitchen order.
2. Call `create_telegram_wayl_checkout` using the server-resolved bot user and cart IDs. Repeated taps reuse the same open checkout for the same basket and slot. A different basket with the same request ID fails.
3. Create one Wayl link with `env`, `referenceId`, `total`, `currency: IQD`, a matching `lineItem`, `webhookUrl`, `webhookSecret`, and `redirectionUrl`. The live API requires the three URL/secret strings even though the OpenAPI flags are less strict. Store and send the URL only if its HTTPS host is exactly `checkout.thewayl.com`.
4. Set a 15-minute link lifetime. Recover a timed-out create by reading the same Wayl reference before any retry. Never create a second charge path for one payment row.
5. Use a Vercel Web Request webhook route. Read at most 64 KiB of raw bytes, verify `x-wayl-signature-256` with constant-time HMAC-SHA256, then parse JSON. Read the link again from Wayl by reference and compare reference, amount, and IQD currency with the database row. Ignore callback status and browser redirect as payment proof.
6. Map Wayl `Complete` and `Delivered` to paid; `Returned` to refunded; `Cancelled` and `Rejected` to cancelled; `Created`, `Pending`, and `Processing` to open. Keep unknown states unchanged. The RPCs make duplicate and stale callbacks idempotent.
7. A live paid callback changes the reserved basket from `pending` to `confirmed` in one transaction, then notifies the customer and staff. A test paid callback changes only payment state and gives a clear test result. A refund changes only payment state and calls for staff review.
8. Reconcile open links by Wayl reference when the customer checks status and in a scheduled bot job. Release a slot only after Wayl confirms a terminal unpaid state or the link has been invalidated at Wayl. Do not release on a local timer alone.
9. Store `WAYL_API_KEY`, `WAYL_WEBHOOK_SECRET`, `WAYL_ENV`, and `WAYL_SITE_URL` in the bot environment only. Missing or invalid values hide the Wayl option and reject callbacks. The return page can tell the customer that confirmation is pending and send them back to the bot; it must not say payment succeeded.

## Purchase journey review

The user approved these changes. The bot now uses an explicit payment choice,
checks item price and availability again, keeps the payment result separate
from the kitchen status, and shows an Arabic retry path for common failures.
The table records the issues found in the full purchase path.

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
| A staff message can fail while the customer sees a confirmed order | `notifyCashiers()` logged send errors and returned | The customer now gets an Arabic warning with the order code if staff delivery fails. Wayl paid notices have durable claim and retry fields. Cash staff notices are queued before confirmation and retried after a failure. |

The current flow already shows topping prices, required topping groups, quantity, basket total, and remaining slot places. Keep those clear parts. Review the final Arabic copy with a local reader before release.

## Durable cash staff notices

The approved journey review asked for a durable cash-order staff notice retry.
The user approved a separate shared production migration. The exact SQL is
[PROPOSED_cash_staff_notices.sql](PROPOSED_cash_staff_notices.sql), with a
[rollback](PROPOSED_cash_staff_notices_rollback.sql). The migration was
applied. No code is deployed.

The migration creates `public.telegram_cash_staff_notices`, one row per order
and staff member, and one service-role RPC. The RPC checks the Telegram owner,
pending basket, basket items, absence of an open Wayl checkout, and active
staff recipients. The bot queues recipients before it confirms a cash order.
A failed send remains pending and a later scheduled run retries it. A sent row
stops duplicate sends from ordinary retries. The table has RLS and no access
for anon or authenticated clients. It does not change website tables, Auth,
existing rows, or existing order functions. The bot will block cash checkout
if no active staff recipient can be queued.

The rollback removes the RPC and table only while the notice table is empty.
If notice history exists, keep it and make a reviewed forward repair instead.
The new queue adds one insert before each cash confirmation and locks the
order row during that insert. This can add brief order-row contention. The
test uses a fake Telegram API and sends no real staff message.

## Test evidence and remaining limits

`npm run check` parsed 42 files. `npm test` passed 40 tests, including forged
signature, wrong secret, tampered body, size limit, amount/currency/reference
mismatch, duplicate and out-of-order callback, unknown reference, a shared
cart button used by another customer, and durable cash notice retry. These
tests use a fake Telegram API.

The production database check used one disposable identity named
`disposable-wayl-test-<random UUID>` with an impossible negative Telegram ID.
It created one pending test basket and item, then deleted both and the identity.
It did not call Wayl or send a Telegram message. The owner, past-slot, and
unknown-reference guards blocked the expected calls. Every active pickup slot
had passed, so a successful checkout RPC and Wayl link could not be
tested on the production database at that time. `WAYL_ENV` has not been set to
live. A controlled test-mode link and signed callback still need verification
before deployment.

A second disposable test identity directly created a `test` payment state row
without calling Wayl. The database blocked item edits during the pending
checkout. A test completion changed payment state to paid while the basket
remained pending with the same slot and order code. Duplicate completion did
not change the order. Refund changed payment state to refunded; a later stale
completion left it refunded. This identity and its rows were removed. An
initial test assertion wrongly expected a pending basket to have no order code;
production generates one by default. The corrected before-and-after check
passed. Neither test sent a customer or staff message.

| Table | Before test | After cleanup |
| --- | ---: | ---: |
| `users` | 19 | 19 |
| `orders` | 75 | 75 |
| `order_items` | 117 | 117 |
| `bot_state` | 0 | 0 |
| `web_payments` | 0 | 0 |
| `telegram_wayl_payments` | 0 | 0 |

A third disposable identity tested the cash notice RPC after its migration.
An unauthorised owner was blocked. Repeating the queue call kept one row per
staff recipient. The test order stayed pending, and no Telegram message was
sent. The identity, basket, item, and notice row were deleted. Counts before
and after were: users 16, orders 75, order items 117, bot state 0, web
payments 0, Wayl payments 0, and cash notices 0.

The Wayl key and webhook secret are not in this repository. Until the bot's
own environment has the four required Wayl values and `CRON_SECRET`, the
payment option stays hidden and callbacks fail closed. Daily cron cleanup and
on-demand status checks handle open links; on a Vercel Hobby plan, the daily
cron schedule can leave an unpaid slot reserved longer than 15 minutes when
the customer never checks status.

Read-only production counts during this proposal (two reads, no writes):

| Table or check | Before | After |
| --- | ---: | ---: |
| `users` | 16 | 16 |
| `users` with `auth_id IS NULL` | 14 | 14 |
| `orders` | 75 | 75 |
| `order_items` | 117 | 117 |
| `bot_state` | 0 | 0 |
| `web_payments` | 0 | 0 |

These first read-only counts were taken before this work. Three users were
added independently before the disposable test; no other table count changed.
