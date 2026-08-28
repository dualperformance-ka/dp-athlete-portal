-- data_requests — athlete-raised data rights requests from the portal.
--
-- dualperformance.au/support tells athletes they can request account deletion
-- from inside the portal, and that verified requests are generally completed
-- within 30 days. A request that only exists as an email in an inbox has no
-- recorded arrival time, so that commitment cannot be evidenced to a wearable
-- API reviewer or a regulator. requested_at and completed_at are that evidence.
--
-- Nothing in this table deletes anything. It records a request a human actions.
--
-- RLS is enabled with NO policies, matching every other table in this project:
-- browsers never reach it, and all access is server-side through the service
-- role via /api/portal-data.

begin;

create table if not exists public.data_requests (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  kind text not null check (kind in ('account_deletion', 'wearable_deletion')),
  note text,
  requested_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  completed_at timestamptz
);

comment on table public.data_requests is
  'Athlete-raised data rights requests from the portal. requested_at/completed_at evidence the 30-day commitment published on dualperformance.au/support.';
comment on column public.data_requests.kind is
  'account_deletion (published queue: delete@dualperformance.au) or wearable_deletion (data@dualperformance.au).';
comment on column public.data_requests.acknowledged_at is
  'When a coach first saw the request. Optional; completed_at is the one that matters for the 30-day commitment.';

-- The open-requests query a coach runs: outstanding work, oldest first.
create index if not exists data_requests_open_idx
  on public.data_requests (requested_at)
  where completed_at is null;

-- Backs the per-athlete, per-kind rate limit in dataRequest().
create index if not exists data_requests_athlete_kind_idx
  on public.data_requests (athlete_code, kind, requested_at desc);

alter table public.data_requests enable row level security;

revoke all on public.data_requests from anon, authenticated;
grant select, insert, update on public.data_requests to service_role;

commit;
