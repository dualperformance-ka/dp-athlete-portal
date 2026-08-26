-- Drop the 2026-08-20 push subscription backup table.
--
-- public.push_subscriptions_backup_20260820 was taken immediately before
-- 20260820103000_collapse_duplicate_push_subscriptions.sql collapsed the
-- duplicate rows. The collapse has long since landed and the live table
-- public.push_subscriptions is the only one api/reminders.js reads.
--
-- What is still sitting there: 35 rows of real Web Push credentials —
-- endpoint URLs, p256dh keys and auth secrets — with no primary key and no
-- indexes. RLS is enabled with zero policies, so anon and authenticated
-- clients cannot reach it and this is not an open leak; service_role can.
-- It is retained credential data that nothing reads, which is exactly the
-- kind of table that outlives the reason it was created.
--
-- Before applying: confirm the collapse produced the subscriptions you
-- expect. Dropping this removes the only copy of the pre-collapse state.

drop table if exists public.push_subscriptions_backup_20260820;
