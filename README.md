# Dual Performance Athlete Portal

A private athlete portal for delivering training, nutrition, progress tracking, and coach feedback through a lightweight Vercel app backed by Notion.

## Immediate Security Step

If a real Notion integration token has ever been committed to this repository, rotate it in Notion before deploying again. Treat committed tokens as compromised.

## Setup

### 1. Configure environment variables in Vercel

In your Vercel project, go to Settings > Environment Variables and add:

- `NOTION_TOKEN`: your private Notion integration token
- `ALLOWED_ORIGINS`: comma-separated production origins, for example `https://your-portal.vercel.app`
- `CHECKIN_DATABASE_ID`: optional Notion database for premium athlete check-ins

Do not commit real tokens, athlete codes, or private database credentials to GitHub.

### 2. Connect Notion databases

The portal currently expects these Notion databases:

- Athlete Database: `4a25a96cc70b82ffa6790139eaa8b458`
- Training Calendar: `0b85a96cc70b836898fd013e0e15c4f2`
- Performance Tracking: `af15a96cc70b821f9f1a012240490fda`

Keep database IDs in code only when they are not sensitive. Keep write-capable credentials in environment variables.

### 3. Deploy

Push to GitHub, import the repository in Vercel, add the environment variables, then deploy.

### 4. Share athlete links

Current MVP access uses athlete codes:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

The root route now loads the premium shell. The original portal remains available at:

```text
https://your-portal.vercel.app/index.html?code=ATHLETE_CODE
```

For a premium production service, replace code-only access with invite links, expiring sessions, or magic-link authentication.

## Structure

```text
api/
  notion.js      Hardened Notion API proxy
  checkin.js     Premium athlete check-in API
public/
  premium.html   Premium command center shell
  index.html     Original athlete portal app
  premium-dashboard.js  Optional in-app premium dashboard module
vercel.json      Routes / to the premium shell
```

## Premium Command Center

The premium shell adds:

- Today's training card
- Weekly coach-focus area
- Readiness score
- Athlete check-in
- Post-session RPE
- Pain/injury flag
- Coach alert state
- Local fallback saving when Notion check-ins are not configured

Create the check-in database using the properties documented in `docs/premium-dashboard.md`, then set `CHECKIN_DATABASE_ID` in Vercel.

## Premium Portal Roadmap

The portal already covers training delivery, completion logging, goals, nutrition, and progress tracking. The next improvements should focus on trust, personalization, and coach operations.

### Phase 1: Trust and Security

- Rotate any exposed Notion token.
- Keep all credentials in Vercel environment variables.
- Restrict CORS with `ALLOWED_ORIGINS`.
- Limit the Notion proxy to known-safe endpoint patterns.
- Move away from plain URL-code access for paid athletes.

### Phase 2: Premium Athlete Experience

- Add a today-first dashboard with the athlete's next session, weekly focus, and coach note.
- Add readiness, sleep, soreness, and motivation check-ins.
- Add post-session RPE, pain flags, and athlete notes.
- Show the athlete why each session matters inside the current training phase.

### Phase 3: Coach Operating System

- Build a coach dashboard for roster status, missed sessions, check-ins, and alerts.
- Add coach notes and interventions per athlete.
- Add weekly review workflows for compliance, fatigue, and progress.
- Add monthly athlete reports that prove service value.

### Phase 4: Product Polish

- Split the single HTML app into components and data modules.
- Add typed data mapping for Notion properties.
- Add empty, loading, and error states for every major view.
- Add basic integration tests for the API proxy.
