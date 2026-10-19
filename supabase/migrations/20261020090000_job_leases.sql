-- Single-flight lease for scheduled jobs (first user: send-athlete-reminders).
--
-- pg_cron fires /api/reminders over pg_net and never waits for the previous
-- call, so a slow run overlapped the next and the backlog grew. The endpoint
-- now calls acquire_job_lease() first and exits without doing any reminder
-- work when another run holds the lease.
--
--   * Atomic: one INSERT ... ON CONFLICT DO UPDATE ... WHERE, serialised by
--     Postgres on the job's row. Exactly one concurrent caller gets a row back.
--   * Self-healing: the lease carries expires_at; a crashed function stops
--     holding it once that passes. No in-memory flag, no session-scoped
--     advisory lock (PostgREST does not keep a session between requests).
--   * Observable: start/finish/duration/outcome/counts of every run, plus how
--     many invocations found the lease held. Counts only, never athlete data.
--
-- Safe to apply before or after the code that uses it. Until it is applied the
-- endpoint runs without overlap protection, exactly as it did before.

create table if not exists public.job_leases (
  job_name text primary key,
  owner text,
  acquired_at timestamptz,
  expires_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_duration_ms integer,
  last_outcome text,
  last_counts jsonb not null default '{}'::jsonb,
  contended_runs bigint not null default 0,
  last_contended_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.job_runs (
  id bigint generated always as identity primary key,
  job_name text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  duration_ms integer,
  outcome text not null,
  counts jsonb not null default '{}'::jsonb
);

create index if not exists job_runs_job_started_idx
  on public.job_runs (job_name, started_at desc);

alter table public.job_leases enable row level security;
alter table public.job_runs enable row level security;
revoke all on table public.job_leases from anon, authenticated;
revoke all on table public.job_runs from anon, authenticated;
grant select, insert, update, delete on table public.job_leases to service_role;
grant select, insert, delete on table public.job_runs to service_role;

comment on table public.job_leases is
  'One row per scheduled job. owner/expires_at is the single-flight lease; last_* and contended_runs are safe operational metadata.';
comment on table public.job_runs is
  'One row per completed scheduled-job run: timing, outcome and aggregate counts only. Purged after 14 days.';

create or replace function public.acquire_job_lease(p_job text, p_owner text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_rows integer;
begin
  if p_job is null or length(p_job) = 0 or length(p_job) > 80 then
    raise exception 'invalid job name';
  end if;
  if p_owner is null or length(p_owner) = 0 or length(p_owner) > 80 then
    raise exception 'invalid lease owner';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 900 then
    raise exception 'invalid lease ttl';
  end if;

  insert into public.job_leases as l (job_name, owner, acquired_at, expires_at, last_started_at, updated_at)
  values (p_job, p_owner, v_now, v_now + make_interval(secs => p_ttl_seconds), v_now, v_now)
  on conflict (job_name) do update
    set owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        last_started_at = excluded.last_started_at,
        updated_at = excluded.updated_at
    where l.owner is null or l.expires_at is null or l.expires_at <= v_now;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    update public.job_leases
       set contended_runs = contended_runs + 1,
           last_contended_at = v_now
     where job_name = p_job;
  end if;
  return v_rows > 0;
end;
$$;

-- Releases only when p_owner still holds the lease, so a run whose lease
-- already expired (and was taken by a newer run) cannot release the newer one.
create or replace function public.release_job_lease(p_job text, p_owner text, p_outcome text, p_counts jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_acquired timestamptz;
  v_duration integer;
  v_outcome text := left(coalesce(nullif(p_outcome, ''), 'ok'), 40);
  v_counts jsonb := case when jsonb_typeof(p_counts) = 'object' then p_counts else '{}'::jsonb end;
begin
  update public.job_leases
     set owner = null,
         expires_at = v_now,
         last_finished_at = v_now,
         last_duration_ms = greatest(0, (extract(epoch from (v_now - acquired_at)) * 1000)::integer),
         last_outcome = v_outcome,
         last_counts = v_counts,
         updated_at = v_now
   where job_name = p_job
     and owner = p_owner
  returning acquired_at, last_duration_ms into v_acquired, v_duration;

  if not found then
    return false;
  end if;

  insert into public.job_runs (job_name, started_at, finished_at, duration_ms, outcome, counts)
  values (p_job, v_acquired, v_now, v_duration, v_outcome, v_counts);
  return true;
end;
$$;

revoke all on function public.acquire_job_lease(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_job_lease(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.acquire_job_lease(text, text, integer) to service_role;
grant execute on function public.release_job_lease(text, text, text, jsonb) to service_role;

-- The Strava "synced in the last 45 minutes" probe runs on every reminder
-- tick. It filters on synced_at, which no existing index covers.
create index if not exists strava_activities_synced_at_idx
  on public.strava_activities (synced_at desc);

-- Keep the run log small. Idempotent: cron.schedule upserts by job name.
select cron.schedule(
  'purge-job-runs',
  '15 16 * * *',
  $$delete from public.job_runs where started_at < now() - interval '14 days';$$
);

notify pgrst, 'reload schema';
