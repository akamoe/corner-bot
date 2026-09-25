-- PROPOSAL ONLY. Apply to corner_bot only after separate approval.
-- This queues staff messages before a Telegram cash basket is confirmed.
begin;

create table public.telegram_cash_staff_notices (
  order_id uuid not null references public.orders(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped')),
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (order_id, staff_id)
);
create index telegram_cash_staff_notices_pending
  on public.telegram_cash_staff_notices(created_at) where status = 'pending';
alter table public.telegram_cash_staff_notices enable row level security;
revoke all on public.telegram_cash_staff_notices from public, anon, authenticated;
grant all on public.telegram_cash_staff_notices to service_role;

create function public.queue_telegram_cash_staff_notices(p_user_id uuid, p_cart_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders;
  v_count integer;
begin
  select * into v_order from public.orders where id = p_cart_id for update;
  if not found or v_order.user_id is distinct from p_user_id
     or v_order.status <> 'pending' then
    raise exception 'CART_NOT_OWNED_OR_PENDING';
  end if;
  if not exists (select 1 from public.users
                 where id = p_user_id and telegram_id is not null) then
    raise exception 'TELEGRAM_OWNER_REQUIRED';
  end if;
  if not exists (select 1 from public.order_items where order_id = p_cart_id) then
    raise exception 'EMPTY_CART';
  end if;
  if exists (select 1 from public.telegram_wayl_payments
             where cart_id = p_cart_id and status = 'pending') then
    raise exception 'WAYL_CHECKOUT_PENDING';
  end if;
  insert into public.telegram_cash_staff_notices(order_id, staff_id)
  select p_cart_id, s.id from public.staff s
  where s.is_active is true and s.role in ('cashier', 'admin')
    and s.telegram_id is not null
  on conflict (order_id, staff_id) do nothing;
  select count(*) into v_count from public.telegram_cash_staff_notices n
  join public.staff s on s.id = n.staff_id
  where n.order_id = p_cart_id and n.status = 'pending'
    and s.is_active is true and s.role in ('cashier', 'admin')
    and s.telegram_id is not null;
  if v_count = 0 then raise exception 'NO_ACTIVE_STAFF_TO_NOTIFY'; end if;
  return v_count;
end;
$$;
revoke all on function public.queue_telegram_cash_staff_notices(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_telegram_cash_staff_notices(uuid, uuid)
  to service_role;

commit;
