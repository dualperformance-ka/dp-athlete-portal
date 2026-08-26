-- Private note from an athlete to their coaches.
--
-- WHY THIS EXISTS
-- Discord is the community channel and it works for that. But an athlete will
-- not post "I think I'm injured" or "I'm thinking of quitting" in a group
-- channel, and those are exactly the messages worth catching early. This is a
-- one-way private line: a small composer in the portal, a row here, and a
-- best-effort notification on top.
--
-- DELIBERATELY NOT A MESSAGING SYSTEM
-- No threads, no replies, no read receipts surfaced to the athlete. read_at
-- exists so a coach tool can mark a note handled; the portal never reads it.
--
-- WRITE PATH
-- POST /api/portal-data { action: 'contact-coach', message }. The athlete code
-- is derived from the authenticated session server-side and is never accepted
-- from the client. The row is written BEFORE any notification is attempted —
-- the table is the source of truth and delivery is best effort on top of it.

begin;

create table if not exists public.contact_messages (
  id           bigserial   primary key,
  athlete_code text        not null,
  body         text        not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);

-- The coach-facing query: unread notes, oldest first.
create index if not exists contact_messages_unread_idx
  on public.contact_messages (created_at)
  where read_at is null;

-- The rate-limit query: this athlete's notes in the last 24 hours.
create index if not exists contact_messages_athlete_created_idx
  on public.contact_messages (athlete_code, created_at desc);

-- ── Lock down ────────────────────────────────────────────────────────────────
--
-- RLS on, no policies, no grants to anon or authenticated — matching every
-- other table in this project. Even a valid athlete JWT reads nothing here
-- directly; access is service-role only, through the authenticated server
-- route. These notes are the most sensitive thing an athlete will write in the
-- portal, so the boundary stays closed.

alter table public.contact_messages enable row level security;

revoke all on public.contact_messages from anon, authenticated;
revoke all on sequence public.contact_messages_id_seq from anon, authenticated;

commit;
