-- Safe only while no cash staff notice row exists. Keep delivery history otherwise.
begin;
do $$
begin
  if exists (select 1 from public.telegram_cash_staff_notices limit 1) then
    raise exception 'CASH_STAFF_NOTICE_HISTORY_PRESENT';
  end if;
end;
$$;
drop function public.queue_telegram_cash_staff_notices(uuid, uuid);
drop table public.telegram_cash_staff_notices;
commit;
