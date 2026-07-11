# Dual Performance Athlete Portal

A private athlete portal for delivering training, nutrition, progress tracking, and coach feedback through a lightweight Vercel app backed by Notion.

## Immediate Security Step

If a real Notion integration token has ever been committed to this repository, rotate it in Notion before deploying again. Treat committed tokens as compromised.

## Setup

### 1. Configure environment variables in Vercel

In your Vercel project, go to Settings > Environment Variables and add:

- `NOTION_TOKEN`: your private Notion integration token
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_KEY`: Supabase service role key, server-side only
- `CRON_SECRET`: secret used by Vercel Cron when retrying queued coach writes
- `ALLOWED_ORIGINS`: comma-separated production origins, for example `https://your-portal.vercel.app`
- `CHECKIN_DATABASE_ID`: `3405a96cc70b80a4b1b9cf5b9c236f18`
- `EMAIL_AUTH_ENABLED`: set to `true` to enable email OTP sign-in for enrolled athletes (see `docs/auth-migration.md`; leave unset for legacy code login only)

Do not commit real tokens, athlete codes, or private database credentials to GitHub.

### 2. Connect Notion databases

The portal currently expects these Notion databases:

- Athlete Database: `4a25a96cc70b82ffa6790139eaa8b458`
- Training Calendar: `0b85a96cc70b836898fd013e0e15c4f2`
- Performance Tracking: `af15a96cc70b821f9f1a012240490fda`
- Daily Athlete BODY Check-in: `3405a96cc70b80a4b1b9cf5b9c236f18`

Keep database IDs in code only when they are not sensitive. Keep write-capable credentials in environment variables.

### Public Client Configuration

The browser bundle intentionally includes public identifiers such as Notion database IDs, the Supabase anon/publishable key, and the Cloudinary cloud/preset names. These are not write-capable secrets by themselves.

Keep these private and server-side only:

- `NOTION_TOKEN`
- `SUPABASE_SERVICE_KEY`
- `CLOUDINARY_API_SECRET`
- `CRON_SECRET`

Supabase access must be protected by RLS policies. Cloudinary unsigned upload presets should be restricted to the expected folder, file types, and size limits.

### 3. Deploy

Push to GitHub, import the repository in Vercel, add the environment variables, then deploy.

### 4. Share athlete links

Current MVP access uses athlete codes:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

The root route loads the athlete portal:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

For a premium production service, replace code-only access with invite links, expiring sessions, or magic-link authentication.

## Structure

```text
api/
  notion.js      Hardened Notion API proxy
  ingest.js      Structured Supabase ingest + Notion mirror
  sync-outbox.js Retries queued coach-readable writes
  checkin.js     Premium athlete check-in API
supabase/
  migrations/    Structured source-of-truth tables
public/
  index.html     Athlete portal app shell and main client logic
  styles.css     Portal styling and responsive layout
  config.js      Public browser config only, no write-capable secrets
  progress-photo-cloud.js  Progress photo cloud upload helper
vercel.json      Routes / to the portal
```

## Data Safety

Athlete submissions are stored in Supabase first, then mirrored to Notion for coach-readable workflows. If Notion is unavailable, the failed mirror write is queued in `coach_write_outbox` and retried by `/api/sync-outbox`.

Apply the migration in `supabase/migrations/202606240001_structured_athlete_ingest.sql` before enabling the structured ingest path in production.

See `docs/backend-data-safety.md` for the full backend flow and deployment notes.

## Premium Command Center

The athlete portal includes:

- Today's training card
- Weekly coach-focus area
- Readiness score
- Athlete body check-in
- Stress, sleep, energy, soreness, motivation, and bodyweight logging
- Post-session RPE
- Pain/injury flag
- Coach alert state
- Local fallback saving when Notion check-ins are not configured

Your BODY check-in database has already been extended with the premium fields: `Session`, `Motivation`, `RPE`, `Pain`, and `Coach Alert`.

## Premium Portal Roadmap

The portal already covers training delivery, completion logging, goals, nutrition, and progress tracking. The next improvements should focus on trust, personalization, and coach operations.

### Phase 1: Trust and Security

- Rotate any exposed Notion token.
- Keep all credentials in Vercel environment variables.
- Restrict CORS with `ALLOWED_ORIGINS`.
- Limit the Notion proxy to known-safe endpoint patterns.
- Move away from plain URL-code access for paid athletes.

### Phase 2: Premium Athlete Experience

- Keep improving the today-first dashboard around the athlete's next action, weekly focus, and coach note.
- Add readiness, sleep, soreness, stress, and motivation check-ins.
- Add post-session RPE, pain flags, and athlete notes.
- Show the athlete why each session matters inside the current training phase.

### Phase 3: Coach Operating System

- Build a coach dashboard for roster status, missed sessions, check-ins, and alerts.
- Add coach notes and interventions per athlete.
- Add weekly review workflows for compliance, fatigue, and progress.
- Add monthly athlete reports that prove service value.

### Phase 4: Product Polish

- Continue splitting the single-file app into focused client modules.
- Add typed data mapping for Notion properties.
- Add empty, loading, and error states for every major view.
- Add basic integration tests for the API proxy.
