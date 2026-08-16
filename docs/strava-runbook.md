# Strava Integration — Deployment Runbook

Phase 0 + 1 of `docs/strava-roadmap.md`. Follow in order — steps 3 and 4 depend
on the deploy being live and publicly reachable.

---

## 0. What changes for athletes

| | Before | After |
|---|---|---|
| Activity source | live pull from Strava on every portal open | webhook → `strava_activities`, read locally |
| History depth | last 100 activities | full window (`STRAVA_BACKFILL_DAYS`, default 180 days) |
| Rate limit pressure | scales with athletes × app opens | scales with actual training volume |
| Match timing | when the athlete opens the app | when the run lands on Strava |
| Scope | `activity:read_all` | `activity:read_all` + `profile:read_all` |

Existing athletes stay connected and their runs keep syncing. They will see a
**"Finish Strava setup"** pill until they re-consent, which grants
`profile:read_all`. Nothing is broken until they do — only the zones-derived
views are unavailable.

---

## 1. Environment variables

Add in Vercel (Project → Settings → Environment Variables), all environments:

| Name | Value |
|---|---|
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | any long random string, e.g. `openssl rand -hex 32` |
| `STRAVA_BACKFILL_DAYS` | optional, defaults to `180` |
| `STRAVA_API_BASE` | optional; leave unset until Jan 2027 (see step 8) |
| `STRAVA_WEBHOOK_SUBSCRIPTION_ID` | set in step 5, not now |

Already present and unchanged: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `PORTAL_URL`.

---

## 2. Apply the migration

```
supabase/migrations/20260816120000_strava_activity_cache.sql
```

Creates `strava_activities`, `strava_webhook_events`, and the
`athlete_data((value->>'strava_athlete_id'))` index the webhook uses to map a
Strava `owner_id` back to an athlete code.

Additive only — no existing table is altered, so it is safe to apply before the
code deploys.

Verify:

```sql
select tablename, rowsecurity from pg_tables
 where tablename in ('strava_activities','strava_webhook_events');
-- both must show rowsecurity = true

select grantee, privilege_type from information_schema.role_table_grants
 where table_name = 'strava_activities';
-- must NOT list anon or authenticated
```

---

## 3. Deploy

```bash
npm run check   # portal checks + 210 tests
```

Then deploy to production. The callback must be live and publicly reachable
before step 4 — Strava validates it synchronously, with a two-second budget, and
a preview URL behind Vercel deployment protection will fail.

---

## 4. Create the push subscription

One subscription per application, covering every athlete. One time only.

```bash
export STRAVA_CLIENT_ID=...
export STRAVA_CLIENT_SECRET=...
export STRAVA_WEBHOOK_VERIFY_TOKEN=...   # must match the deployed value
export PORTAL_URL=https://dp-athlete-portal.vercel.app

node scripts/strava-subscription.mjs view     # confirm none exists
node scripts/strava-subscription.mjs create
```

If `create` fails, the cause is almost always one of, in order: the callback is
not deployed or is behind deployment protection; the verify token here does not
match the deployed one; a subscription already exists (`view`, then
`delete <id>`).

---

## 5. Pin the subscription id

Set `STRAVA_WEBHOOK_SUBSCRIPTION_ID` in Vercel to the id returned by step 4 and
redeploy. Events from any other subscription are then ignored.

---

## 6. Verify

1. **Handshake** — `GET /api/strava-webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=x`
   must return **403**. A 200 means the token check is not reading your env var.
2. **First athlete** — open the portal as a connected athlete. Their history
   should appear on that first load (the catch-up backfill runs inline, so it may
   take a few seconds once, then never again).
3. **Live event** — record a run, or edit an existing activity's title on Strava.
   Within a minute:
   ```sql
   select aspect_type, object_id, processed_at, attempts, last_error
     from strava_webhook_events order by received_at desc limit 5;
   ```
   `processed_at` should be set and `last_error` null.
4. **Cache populated**
   ```sql
   select athlete_code, count(*), max(start_date_local), max(synced_at)
     from strava_activities group by athlete_code;
   ```
5. **Disconnect** — run `disconnectStrava({confirmed:true})` from the console on
   a test athlete. `strava_activities` rows for that code must be gone, and the
   app must disappear from that athlete's Strava settings.

---

## 7. Tell the cohort

Athletes need one re-consent to grant `profile:read_all`. Suggested message:

> Quick one — tap the orange **Finish Strava setup** button in your portal when
> you get a sec. It lets the portal read your Strava heart-rate and pace zones,
> so effort and time-in-zone start showing up against your sessions. Your runs
> are already syncing either way, so nothing's broken if you don't get to it
> today.

---

## 8. Deferred

- **Jan 2027** — Strava's base URL moves to `https://api-v3.strava.com`. Set
  `STRAVA_API_BASE` to it and redeploy. No code change.
- **Athlete capacity** — the app's cap needs to be above the cohort size. Default
  is 1, self-service upgrade takes it to 10, beyond that needs app review. Check
  it in the Strava API settings dashboard before the cohort grows past 10.
- **Developer subscription** — standard API access has required an active Strava
  membership on the developer account since 1 June 2026.

---

## Rollback

The change is additive on the database side, so rollback is a code revert:
redeploy the previous build. The tables can stay — nothing else reads them, and
keeping them means no re-backfill when you roll forward again.

If the webhook itself is the problem but the cache is fine, delete the
subscription (`node scripts/strava-subscription.mjs delete <id>`). Reads keep
serving from the cache; it just stops updating.

---

## Operating notes

**Where activities come from.** `GET /api/strava` never calls Strava for
activities. It reads `strava_activities`. The only outbound calls on that path
are a token refresh when the stored one has expired (a liveness check — without
it a revoked token would go unnoticed behind a green "connected" pill) and the
one-time catch-up backfill.

**Queue drains in three places**, deliberately overlapping — Strava's two-second
ack budget means the webhook cannot both process and reply reliably:

1. immediately after the webhook acks (best effort, and what makes a match land
   before the athlete opens the app);
2. on the athlete's next portal read, scoped to them, max 5 events;
3. never automatically beyond that — Vercel Hobby allows two cron jobs and both
   are in use. If the queue backs up, drain it manually or add a call to
   `drainEvents()` inside `api/reminders.js`, which already runs daily.

**Events stop retrying after 5 attempts.** Something permanently broken must not
starve good events out of every drain window. Find them with:

```sql
select * from strava_webhook_events
 where processed_at is null and attempts >= 5;
```

**The compliance boundary is enforced in two places** and both must hold: the
cache tables grant nothing to `anon`/`authenticated`, and `/api/strava` scopes
every read to the authenticated athlete's own code. The coaches dashboard reads
`training_session_logs` — Dual Performance's own data — never `strava_activities`.
`tests/strava.test.js` fails if either is loosened.
