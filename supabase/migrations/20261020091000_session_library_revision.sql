-- Cheap, deterministic revision for the session library cache.
--
-- The portal used to decide whether its cached library was current by
-- selecting up to 1,000 full session_library rows and hashing them on the
-- server, on every revision check. This keeps a counter that a statement-level
-- trigger bumps whenever the library changes (insert, update, delete,
-- truncate), so the check is a one-row primary-key read.
--
-- Correct invalidation: any write to session_library changes the counter, and
-- the portal compares the counter string, never a timestamp. If this migration
-- has not been applied, api/write.js falls back to the old hash.

create table if not exists public.cache_revisions (
  name text primary key,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.cache_revisions enable row level security;
revoke all on table public.cache_revisions from anon, authenticated;
grant select, insert, update on table public.cache_revisions to service_role;

comment on table public.cache_revisions is
  'Monotonic revision counters maintained by triggers, used by portal caches instead of hashing whole tables.';

insert into public.cache_revisions (name, revision)
values ('session_library', 1)
on conflict (name) do nothing;

create or replace function public.bump_cache_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.cache_revisions as r (name, revision, updated_at)
  values (tg_argv[0], 1, now())
  on conflict (name) do update
    set revision = r.revision + 1,
        updated_at = now();
  return null;
end;
$$;

revoke all on function public.bump_cache_revision() from public, anon, authenticated;

drop trigger if exists session_library_cache_revision on public.session_library;
create trigger session_library_cache_revision
  after insert or update or delete or truncate on public.session_library
  for each statement
  execute function public.bump_cache_revision('session_library');

notify pgrst, 'reload schema';
