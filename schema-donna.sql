-- ===========================================================================
--  Ask Donna — rate-limit counters.  Run after schema.sql.  Safe to re-run.
--
--  Nothing anybody types to Donna is stored. This table only counts messages:
--  per visitor per ten minutes, per visitor per day, and for the whole site
--  per day (the DONNA_DAILY_CAP backstop). A visitor is a salted hash of their
--  IP worked out in /api/donna, never the IP itself, and every row expires
--  within a day.
-- ===========================================================================

create table if not exists public.donna_usage (
    bucket      text        primary key,
    hits        integer     not null default 0,
    expires_at  timestamptz not null
);

create index if not exists donna_usage_expiry_idx on public.donna_usage (expires_at);

-- One call per message: add one to each of the three counters and hand back
-- the new totals. The day is the day in Ireland, so the cap resets at midnight
-- here rather than at midnight UTC.
create or replace function public.donna_tick(p_visitor text)
returns table (ip_10m integer, ip_day integer, all_day integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_slot  bigint := floor(extract(epoch from now()) / 600);
    v_day   text   := to_char(now() at time zone 'Europe/Dublin', 'YYYY-MM-DD');
    v_10m   integer;
    v_ipday integer;
    v_all   integer;
begin
    if p_visitor is null or length(p_visitor) < 8 or length(p_visitor) > 64 then
        raise exception 'bad visitor key';
    end if;

    insert into donna_usage as u (bucket, hits, expires_at)
    values ('v10:' || p_visitor || ':' || v_slot, 1, now() + interval '10 minutes')
    on conflict (bucket) do update set hits = u.hits + 1
    returning u.hits into v_10m;

    insert into donna_usage as u (bucket, hits, expires_at)
    values ('vday:' || p_visitor || ':' || v_day, 1, now() + interval '1 day')
    on conflict (bucket) do update set hits = u.hits + 1
    returning u.hits into v_ipday;

    insert into donna_usage as u (bucket, hits, expires_at)
    values ('all:' || v_day, 1, now() + interval '2 days')
    on conflict (bucket) do update set hits = u.hits + 1
    returning u.hits into v_all;

    -- Tidy up now and then rather than on every message.
    if random() < 0.02 then
        delete from donna_usage where expires_at < now();
    end if;

    return query select v_10m, v_ipday, v_all;
end;
$$;

-- Lock it down, same as everything else: only the serverless functions, with
-- the service_role key, can touch it.
alter table public.donna_usage enable row level security;
revoke all on public.donna_usage from anon, authenticated;
revoke execute on function public.donna_tick(text) from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant select, insert, update, delete on public.donna_usage to service_role;
        grant execute on function public.donna_tick(text) to service_role;
    end if;
end $$;
