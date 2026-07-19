# Dual Performance Athlete Portal

A private athlete portal for delivering training, nutrition, progress tracking, and coach feedback through a lightweight Vercel app backed by Supabase.

> **Note:** The Notion integration was removed on 2026-07-20. Supabase is the single source of truth for all portal data — there is no external mirror or sync.

## Setup

### 1. Configure environment variables in Vercel

In your Vercel project, go to Settings > Environment Variables and add:

- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_KEY`: Supabase service role key, server-side only
- `ALLOWED_ORIGINS`: comma-separated production origins, for example `https://your-portal.vercel.app`
- `GHL_API_KEY`: (optional) enables the weekly check-in `checkin_done` GHL tag
- `EMAIL_AUTH_ENABLED`: set to `true` to enable email OTP sign-in for enrolled athletes (see `docs/auth-migration.md`; leave unset for legacy code login only)

`NOTION_TOKEN` and `CRON_SECRET` are no longer used and should be deleted from the Vercel project.

Do not commit real tokens, athlete codes, or private database credentials to GitHub.

### Public Client Configuration

The browser bundle intentionally includes public identifiers such as the Supabase anon/publishable key and the Cloudinary cloud/preset names. These are not write-capable secrets by themselves.

Keep these private and server-side only:

- `SUPABASE_SERVICE_KEY`
- `CLOUDINARY_API_SECRET`

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
  ingest.js      Structured Supabase ingest (single write endpoint)
  my-logs.js     Athlete-facing read of their own structured logs
  athletes.js    Roster management (source of truth for identity)
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

Athlete submissions are written straight into the Supabase source-of-truth tables by `/api/ingest`. Supabase is the only backend — there is no external mirror. If a Supabase write fails, the browser keeps the payload in a local retry queue and replays it when back online.

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
- Local fallback saving when the network is unavailable

### Responsive experience

- Desktop uses a persistent left navigation rail, an athlete command-center hero, weekly output rings, and wide data layouts.
- Tablet keeps the full portal hierarchy while compressing the hero and content grids.
- Mobile prioritizes today&rsquo;s session, compact weekly signals, touch-sized controls, and a five-item bottom navigation.
- Outdoor mode preserves the same information hierarchy with a daylight-friendly palette.

The root and `public/` copies of `index.html` and `styles.css` are intentionally kept identical so local previews and Vercel&rsquo;s public app shell render the same interface.

Your BODY check-in database has already been extended with the premium fields: `Session`, `Motivation`, `RPE`, `Pain`, and `Coach Alert`.

## Premium Portal Roadmap

The portal already covers training delivery, completion logging, goals, nutrition, and progress tracking. The next improvements should focus on trust, personalization, and coach operations.

### Phase 1: Trust and Security

- Keep all credentials in Vercel environment variables.
- Restrict CORS with `ALLOWED_ORIGINS`.
- Enforce Supabase RLS on every table.
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
- Add typed data mapping for the Supabase row shapes.
- Add empty, loading, and error states for every major view.
- Add basic integration tests for the ingest endpoint.
