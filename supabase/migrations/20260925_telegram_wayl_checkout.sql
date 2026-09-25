-- PROPOSAL ONLY. Never run this file without explicit approval.
-- Target: Supabase corner_bot (halujssasooosxyjruhg).
-- The web app and bot both use this production database.
begin;

create table public.telegram_wayl_payments (
  reference text primary key,
  request_id uuid not null,
  user_id uuid not null references public.users(id),
  cart_id uuid not null references public.orders(id),
  slot_id uuid not null references public.pickup_slots(id),
  environment text not null check (environment in ('test', 'live')),
  amount numeric not null check (amount >= 1000 and amount = trunc(amount)),
  currency text not null default 'IQD' check (currency = 'IQD'),
  basket_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'cancelled', 'refunded')),
  checkout_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  refunded_at timestamptz,
  customer_notified_at timestamptz,
  customer_notify_claimed_at timestamptz,
  staff_notified_at timestamptz,
  staff_notify_claimed_at timestamptz,
  unique (user_id, request_id)
);

create unique index telegram_wayl_one_pending_cart
  on public.telegram_wayl_payments(cart_id) where status = 'pending';
create index telegram_wayl_pending_expiry
  on public.telegram_wayl_payments(expires_at) where status = 'pending';
comment on table public.telegram_wayl_payments is
  'Telegram Wayl payment state. Order fulfilment remains in public.orders.';
alter table public.telegram_wayl_payments enable row level security;
revoke all on public.telegram_wayl_payments from public, anon, authenticated;
grant all on public.telegram_wayl_payments to service_role;

-- This is an equality check for a trusted database snapshot, not a password hash.
create function public.telegram_wayl_basket_hash(p_cart_id uuid, p_slot_id uuid)
returns text language sql stable set search_path = '' as $$
  select md5(
    coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'menu_item_id', i.menu_item_id,
      'name', i.item_name, 'price', i.item_price,
      'quantity', i.quantity, 'customization', i.customization
    ) order by i.id)::text
    from public.order_items i where i.order_id = p_cart_id), '[]')
    || coalesce((select o.notes from public.orders o where o.id = p_cart_id), '')
    || p_slot_id::text
  );
$$;

-- Every item write locks its parent order. This serializes basket edits with
-- checkout reservation and prevents edits after a checkout is reserved.
create function public.telegram_wayl_guard_items()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cart_id uuid;
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    v_ids := array[new.order_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.order_id];
  else
    v_ids := array[old.order_id, new.order_id];
  end if;
  for v_cart_id in
    select distinct u.id from unnest(v_ids) as u(id)
    where u.id is not null order by u.id
  loop
    perform 1 from public.orders where id = v_cart_id for update;
    if exists (
      select 1 from public.telegram_wayl_payments p
      where p.cart_id = v_cart_id and p.status = 'pending'
    ) then
      raise exception 'TELEGRAM_CHECKOUT_LOCKED';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger telegram_wayl_guard_items
before insert or update or delete on public.order_items
for each row execute function public.telegram_wayl_guard_items();

-- A pending Wayl payment stops a direct cash confirmation, note edit, or
-- slot change. Only the payment RPC sets the transaction-local reference.
create function public.telegram_wayl_guard_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_reference text;
begin
  select p.reference into v_reference
  from public.telegram_wayl_payments p
  where p.cart_id = old.id and p.status = 'pending';
  if v_reference is not null and (
    new.status is distinct from old.status or
    new.slot_id is distinct from old.slot_id or
    new.notes is distinct from old.notes or
    new.total_amount is distinct from old.total_amount or
    new.order_code is distinct from old.order_code
  ) and current_setting('corner.telegram_wayl_reference', true)
      is distinct from v_reference then
    raise exception 'TELEGRAM_CHECKOUT_LOCKED';
  end if;
  return new;
end;
$$;
create trigger telegram_wayl_guard_order
before update on public.orders
for each row execute function public.telegram_wayl_guard_order();

-- Lock the user row so two first adds cannot create two active bot baskets.
create function public.get_or_create_telegram_cart(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cart public.orders;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  select * into v_cart from public.orders
  where user_id = p_user_id and status = 'pending'
  order by created_at desc limit 1;
  if not found then
    insert into public.orders(user_id, status) values(p_user_id, 'pending')
    returning * into v_cart;
  end if;
  return to_jsonb(v_cart);
end;
$$;

create function public.create_telegram_wayl_checkout(
  p_user_id uuid, p_cart_id uuid, p_slot_id uuid,
  p_request_id uuid, p_environment text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cart public.orders;
  v_slot public.pickup_slots;
  v_payment public.telegram_wayl_payments;
  v_amount numeric;
  v_hash text;
  v_code text;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_attempt integer;
begin
  if p_user_id is null or p_cart_id is null or p_slot_id is null
     or p_request_id is null or p_environment not in ('test', 'live') then
    raise exception 'INVALID_CHECKOUT';
  end if;
  select * into v_cart from public.orders where id = p_cart_id for update;
  if not found or v_cart.user_id is distinct from p_user_id
     or v_cart.status <> 'pending' then
    raise exception 'CART_NOT_OWNED_OR_PENDING';
  end if;
  if not exists (select 1 from public.order_items where order_id = p_cart_id) then
    raise exception 'EMPTY_CART';
  end if;
  if exists (
    select 1 from public.order_items i where i.order_id = p_cart_id
    and (i.item_price is null or i.item_price < 0
      or i.quantity is null or i.quantity < 1 or i.quantity > 99)
  ) then
    raise exception 'INVALID_CART_LINE';
  end if;
  select sum(i.item_price * i.quantity) into v_amount
  from public.order_items i where i.order_id = p_cart_id;
  if v_amount < 1000 or v_amount <> trunc(v_amount) then
    raise exception 'INVALID_AMOUNT';
  end if;
  v_hash := public.telegram_wayl_basket_hash(p_cart_id, p_slot_id);

  select * into v_payment from public.telegram_wayl_payments
  where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_payment.cart_id <> p_cart_id or v_payment.slot_id <> p_slot_id
      or v_payment.environment <> p_environment
      or v_payment.amount <> v_amount or v_payment.basket_hash <> v_hash then
      raise exception 'REQUEST_REUSED_FOR_DIFFERENT_BASKET';
    end if;
    return to_jsonb(v_payment);
  end if;

  select * into v_payment from public.telegram_wayl_payments
  where cart_id = p_cart_id and status = 'pending';
  if found then
    if v_payment.user_id <> p_user_id or v_payment.slot_id <> p_slot_id
      or v_payment.environment <> p_environment
      or v_payment.amount <> v_amount or v_payment.basket_hash <> v_hash then
      raise exception 'CHECKOUT_ALREADY_PENDING';
    end if;
    return to_jsonb(v_payment);
  end if;

  select * into v_slot from public.pickup_slots where id = p_slot_id for update;
  if not found or v_slot.is_active is not true
    or (now() at time zone 'Asia/Baghdad')::time >= v_slot.slot_time then
    raise exception 'SLOT_UNAVAILABLE';
  end if;
  if coalesce(v_slot.max_orders, 0) > 0 and (
    select count(*) from public.orders o
    where o.slot_id = p_slot_id and o.status <> 'cancelled'
      and (o.created_at at time zone 'Asia/Baghdad')::date =
          (now() at time zone 'Asia/Baghdad')::date
  ) >= coalesce(v_slot.max_orders, 0) then
    raise exception 'SLOT_FULL';
  end if;

  if p_environment = 'live' then
    -- This pending order reserves capacity for both bot and website queries.
    for v_attempt in 1..20 loop
      v_code := 'ORD-';
      for i in 1..5 loop
        v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1);
      end loop;
      begin
        update public.orders set slot_id = p_slot_id,
          total_amount = v_amount, order_code = v_code
        where id = p_cart_id and status = 'pending';
        exit;
      exception when unique_violation then
        if v_attempt = 20 then raise; end if;
      end;
    end loop;
  end if;

  insert into public.telegram_wayl_payments (
    reference, request_id, user_id, cart_id, slot_id,
    environment, amount, basket_hash, expires_at
  ) values (
    'corner-bot-' || gen_random_uuid()::text, p_request_id, p_user_id,
    p_cart_id, p_slot_id, p_environment, v_amount, v_hash,
    now() + interval '15 minutes'
  ) returning * into v_payment;
  return to_jsonb(v_payment);
end;
$$;

create function public.complete_telegram_wayl_payment(p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payment public.telegram_wayl_payments;
  v_code text;
begin
  select * into v_payment from public.telegram_wayl_payments
  where reference = p_reference for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_payment.status = 'cancelled' then
    raise exception 'CANCELLED_PAYMENT_REQUIRES_REVIEW';
  end if;
  if v_payment.status = 'refunded' then
    return jsonb_build_object('status', 'refunded', 'environment', v_payment.environment);
  end if;
  if v_payment.status = 'pending' then
    if v_payment.environment = 'live' then
      perform 1 from public.orders where id = v_payment.cart_id for update;
      if not found or (
        select status from public.orders where id = v_payment.cart_id
      ) <> 'pending' or public.telegram_wayl_basket_hash(
        v_payment.cart_id, v_payment.slot_id
      ) <> v_payment.basket_hash then
        raise exception 'PAID_BASKET_REQUIRES_REVIEW';
      end if;
      perform set_config('corner.telegram_wayl_reference', p_reference, true);
      update public.orders set status = 'confirmed'
      where id = v_payment.cart_id and status = 'pending';
    end if;
    update public.telegram_wayl_payments
    set status = 'paid', paid_at = now()
    where reference = p_reference and status = 'pending';
  end if;
  if v_payment.environment = 'live' then
    select order_code into v_code from public.orders where id = v_payment.cart_id;
  end if;
  return jsonb_build_object('status', 'paid', 'environment', v_payment.environment,
    'order_code', v_code);
end;
$$;

-- Call only after Wayl confirms a terminal unpaid state or the link is
-- invalidated at Wayl. Never cancel a live link from a chat button alone.
create function public.cancel_telegram_wayl_payment(p_reference text)
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
      update public.orders set slot_id = null, total_amount = null,
        order_code = null
      where id = v_payment.cart_id and status = 'pending';
    end if;
    update public.telegram_wayl_payments set status = 'cancelled'
    where reference = p_reference and status = 'pending';
  end if;
  return jsonb_build_object('status', 'cancelled', 'environment', v_payment.environment);
end;
$$;

-- A refund changes payment state only. Staff must review fulfilment.
create function public.refund_telegram_wayl_payment(p_reference text)
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
    update public.orders set slot_id = null, total_amount = null,
      order_code = null where id = v_payment.cart_id and status = 'pending';
  end if;
  if v_payment.status <> 'refunded' then
    update public.telegram_wayl_payments set status = 'refunded', refunded_at = now()
    where reference = p_reference;
  end if;
  return jsonb_build_object('status', 'refunded', 'environment', v_payment.environment);
end;
$$;

revoke all on function public.telegram_wayl_basket_hash(uuid, uuid),
  public.get_or_create_telegram_cart(uuid),
  public.create_telegram_wayl_checkout(uuid, uuid, uuid, uuid, text),
  public.complete_telegram_wayl_payment(text),
  public.cancel_telegram_wayl_payment(text),
  public.refund_telegram_wayl_payment(text)
from public, anon, authenticated;
grant execute on function public.telegram_wayl_basket_hash(uuid, uuid),
  public.get_or_create_telegram_cart(uuid),
  public.create_telegram_wayl_checkout(uuid, uuid, uuid, uuid, text),
  public.complete_telegram_wayl_payment(text),
  public.cancel_telegram_wayl_payment(text),
  public.refund_telegram_wayl_payment(text)
to service_role;

commit;
