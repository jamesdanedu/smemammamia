-- ===========================================================================
--  MAMMA MIA! — email confirmations and payment reconciliation
--
--  Run this AFTER schema.sql, in the Supabase SQL Editor.
--  Safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Email state on the booking
-- ---------------------------------------------------------------------------
alter table public.bookings add column if not exists confirmation_sent_at    timestamptz;
alter table public.bookings add column if not exists confirmation_claimed_at timestamptz;
alter table public.bookings add column if not exists confirmation_attempts   integer not null default 0;
alter table public.bookings add column if not exists last_email_error        text;
-- Superseded by seat_conflict (schema-seating.sql); kept so nothing breaks.
alter table public.bookings add column if not exists over_capacity           boolean not null default false;

-- find the unsent ones fast
create index if not exists bookings_unsent_idx
    on public.bookings (status, confirmation_sent_at)
    where status = 'confirmed' and confirmation_sent_at is null;

-- find abandoned checkouts fast
create index if not exists bookings_unreconciled_idx
    on public.bookings (status, sumup_checkout_id)
    where status = 'held' and sumup_checkout_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Audit log — every send attempt, kept for the whole run
-- ---------------------------------------------------------------------------
create table if not exists public.email_log (
    id                uuid primary key default gen_random_uuid(),
    booking_reference text,
    to_email          text        not null,
    kind              text        not null default 'confirmation',
    provider          text,
    provider_id       text,
    status            text        not null check (status in ('sent', 'failed')),
    error             text,
    created_at        timestamptz not null default now()
);

create index if not exists email_log_ref_idx  on public.email_log (booking_reference, created_at desc);
create index if not exists email_log_time_idx on public.email_log (created_at desc);

alter table public.email_log enable row level security;
revoke all on public.email_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Claim a confirmation email.
--
--    success.html verifies up to four times, the reconciler runs on a
--    schedule, and the admin can hit resend.  Without a claim, a customer
--    could get the same email five times.  This hands the send to exactly
--    one caller; a claim that dies mid-flight is reclaimable after 5 minutes.
--
--    Returns the booking row, or nothing if someone else holds the claim.
-- ---------------------------------------------------------------------------
create or replace function public.claim_confirmation_email(
    p_reference text,
    p_force     boolean default false     -- true = admin resend, ignores sent_at
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row public.bookings;
begin
    update public.bookings
       set confirmation_claimed_at = now(),
           confirmation_attempts   = confirmation_attempts + 1
     where booking_reference = p_reference
       and status = 'confirmed'
       -- An admin pressing Resend means it: skip both guards.
       -- Otherwise: not already sent, and not already in flight.
       and (p_force
            or (confirmation_sent_at is null
                and (confirmation_claimed_at is null
                     or confirmation_claimed_at < now() - interval '5 minutes')))
    returning * into v_row;

    return v_row;   -- null row when the claim was not granted
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Mark the outcome
-- ---------------------------------------------------------------------------
create or replace function public.record_email_result(
    p_reference   text,
    p_to          text,
    p_kind        text,
    p_ok          boolean,
    p_provider    text default null,
    p_provider_id text default null,
    p_error       text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.email_log (booking_reference, to_email, kind, provider, provider_id, status, error)
    values (p_reference, p_to, coalesce(p_kind, 'confirmation'), p_provider, p_provider_id,
            case when p_ok then 'sent' else 'failed' end, left(p_error, 1000));

    if p_ok then
        update public.bookings
           set confirmation_sent_at = coalesce(confirmation_sent_at, now()),
               last_email_error     = null
         where booking_reference = p_reference;
    else
        update public.bookings
           set last_email_error       = left(p_error, 500),
               confirmation_claimed_at = null   -- release so the next sweep retries
         where booking_reference = p_reference;
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Confirming a paid booking
--
--    confirm_paid_booking lives in schema-seating.sql, because confirming a
--    payment means giving the booking its seats back — or flagging it when
--    they have gone. It used to be here; keeping one copy means re-running
--    this file can never put the old, seat-blind version back.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. Lock the new function down
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_confirmation_email(text, boolean)                    from anon, authenticated;
revoke execute on function public.record_email_result(text, text, text, boolean, text, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Handy queries
-- ---------------------------------------------------------------------------
-- Who has not had their confirmation yet?
--     select booking_reference, customer_name, customer_email,
--            confirmation_attempts, last_email_error
--     from public.bookings
--     where status = 'confirmed' and confirmation_sent_at is null;
--
-- Every send attempt for one booking:
--     select * from public.email_log where booking_reference = 'MM-XXXXXX' order by created_at;
--
-- Paid bookings whose seats went while the customer was away:
--     select * from public.bookings where seat_conflict;
