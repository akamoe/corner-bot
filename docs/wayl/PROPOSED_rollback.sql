-- PROPOSAL ONLY. Safe only before any checkout row exists.
-- If this guard fails, keep the payment history and prepare a data-preserving
-- repair with a verified backup. Never drop paid records to roll back code.
begin;
do $$
begin
  if exists (select 1 from public.telegram_wayl_payments limit 1) then
    raise exception 'TELEGRAM_PAYMENT_HISTORY_PRESENT';
  end if;
end;
$$;

drop trigger telegram_wayl_guard_items on public.order_items;
drop trigger telegram_wayl_guard_order on public.orders;
drop function public.telegram_wayl_guard_items();
drop function public.telegram_wayl_guard_order();
drop function public.get_or_create_telegram_cart(uuid);
drop function public.create_telegram_wayl_checkout(uuid, uuid, uuid, uuid, text);
drop function public.complete_telegram_wayl_payment(text);
drop function public.cancel_telegram_wayl_payment(text);
drop function public.refund_telegram_wayl_payment(text);
drop function public.telegram_wayl_basket_hash(uuid, uuid);
drop table public.telegram_wayl_payments;
commit;
