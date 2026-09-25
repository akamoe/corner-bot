-- PROPOSAL ONLY. Requires separate approval before production use.
-- Target: corner_bot (halujssasooosxyjruhg).
-- orders.order_code is NOT NULL, so keep the existing code when releasing
-- an unpaid Wayl reservation or recording a refund before capture.
begin;

create or replace function public.cancel_telegram_wayl_payment(p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payment public.telegram_wayl_payments;
begin
  select * into v_payment from public.telegram_wayl_payments
  where reference = p_reference for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_payment.status in ('paid', 'refunded') then
    raise exception 'PAID_PAYMENT_CANNOT_BE_CANCELLED';
  end if;
  if v_payment.status = 'pending' then
    if v_payment.environment = 'live' then
      perform set_config('corner.telegram_wayl_reference', p_reference, true);
      update public.orders set slot_id = null, total_amount = null
      where id = v_payment.cart_id and status = 'pending';
    end if;
    update public.telegram_wayl_payments set status = 'cancelled'
    where reference = p_reference and status = 'pending';
  end if;
  return jsonb_build_object('status', 'cancelled', 'environment', v_payment.environment);
end;
$$;

-- A refund changes payment state only. Staff must review fulfilment.
create or replace function public.refund_telegram_wayl_payment(p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payment public.telegram_wayl_payments;
begin
  select * into v_payment from public.telegram_wayl_payments
  where reference = p_reference for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_payment.status = 'cancelled' then
    raise exception 'CANCELLED_PAYMENT_REQUIRES_REVIEW';
  end if;
  if v_payment.status = 'pending' and v_payment.environment = 'live' then
    perform set_config('corner.telegram_wayl_reference', p_reference, true);
    update public.orders set slot_id = null, total_amount = null where id = v_payment.cart_id and status = 'pending';
  end if;
  if v_payment.status <> 'refunded' then
    update public.telegram_wayl_payments set status = 'refunded', refunded_at = now()
    where reference = p_reference;
  end if;
  return jsonb_build_object('status', 'refunded', 'environment', v_payment.environment);
end;
$$;

commit;
