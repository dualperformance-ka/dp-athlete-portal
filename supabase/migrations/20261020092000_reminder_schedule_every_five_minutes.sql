-- Versioned schedule for the athlete reminder job.
--
-- Until now the live job (send-athlete-reminders, every minute) existed only
-- as dashboard state, with the cron bearer secret written into cron.job in
-- plain text. This migration makes the schedule reproducible from the repo and
-- moves the secret into Supabase Vault:
--
--   * every five minutes instead of every minute. Reminder windows are fifteen
--     minutes wide (api/_lib/reminder-plan.js), so each reminder gets three
--     chances and a skipped run cannot lose it; the batched dedupe read stops
--     the later chances from sending twice.
--   * the secret is read from vault.decrypted_secrets at run time, never
--     stored in cron.job.command.
--   * the pg_net timeout matches the function's 60s maxDuration.
--
-- PREREQUISITES — this migration refuses to run without them:
--   1. The code from this change is deployed (the old code assumed a run
--      every minute and a 2-minute window, and would miss reminders at a
--      5-minute cadence).
--   2. The Vault secret exists, created once in the SQL editor with the same
--      value as REMINDERS_CRON_SECRET (or CRON_SECRET) in Vercel:
--        select vault.create_secret('<the secret>', 'reminders_cron_secret',
--          'Bearer token pg_cron sends to /api/reminders');
--
-- Rollback: docs/reminder-scheduling.md.

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'reminders_cron_secret') then
    raise exception 'Vault secret reminders_cron_secret is missing. Create it first (see the header of this migration).';
  end if;
end
$$;

-- cron.schedule upserts by job name, so this replaces the every-minute job in
-- place and is safe to re-run.
select cron.schedule(
  'send-athlete-reminders',
  '*/5 * * * *',
  $job$
  select net.http_get(
    url := 'https://portal.dualperformance.au/api/reminders',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret' limit 1)
    ),
    timeout_milliseconds := 60000
  );
  $job$
);
