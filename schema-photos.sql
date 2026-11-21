-- ===========================================================================
--  Photos — uploaded from the admin page.  Run after schema.sql.  Safe to re-run.
--
--  The image files live in a public Supabase Storage bucket called "photos";
--  this table holds the caption, the order and whether each one is shown.
--  Anyone can view a photo by its URL (that is what the Photos page does), but
--  only the serverless functions, with the service_role key, can add, change or
--  remove one. Uploads go straight from the admin page to Storage through a
--  one-time signed URL that /api/admin hands out after checking the password.
-- ===========================================================================

create table if not exists public.photos (
    id          bigint generated always as identity primary key,
    path        text        not null unique,          -- file name inside the bucket
    caption     text        not null default '',
    sort_order  integer     not null default 0,
    visible     boolean     not null default true,
    width       integer,
    height      integer,
    created_at  timestamptz not null default now()
);

create index if not exists photos_order_idx on public.photos (sort_order, id);

alter table public.photos enable row level security;
revoke all on public.photos from anon, authenticated;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant select, insert, update, delete on public.photos to service_role;
        grant usage on sequence public.photos_id_seq to service_role;
    end if;
end $$;

-- The bucket: public to read, 6 MB per file, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 6291456, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
