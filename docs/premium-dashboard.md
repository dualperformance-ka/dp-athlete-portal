# Premium Dashboard Rollout

This rollout added the product layer that makes the athlete portal feel like a coached service rather than a data viewer.

## New Experience

The athlete portal now includes:

- Today's training card
- Weekly coach-focus area
- Readiness score
- Athlete body check-in
- Stress, sleep, energy, soreness, motivation, and bodyweight logging
- Post-session RPE
- Pain/injury flag
- Coach alert state
- Local fallback saving when Notion is not configured

## Files

- `public/index.html`: athlete portal with the premium command-center flows integrated
- `api/checkin.js`: writes athlete check-ins into the BODY check-in database
- `vercel.json`: routes `/` to `index.html`

## Vercel Environment Variables

Add these before enabling Notion-backed check-ins:

```text
NOTION_TOKEN=your_rotated_notion_token
ALLOWED_ORIGINS=https://your-portal-domain.vercel.app
CHECKIN_DATABASE_ID=3405a96cc70b80a4b1b9cf5b9c236f18
```

## Notion BODY Check-In Database

Connected database:

```text
Daily Athlete BODY Check-in: 3405a96cc70b80a4b1b9cf5b9c236f18
Data source: collection://3405a96c-c70b-80e0-a288-000b432e6ffa
```

The portal now writes to these properties:

| Portal field | Notion property | Type |
| --- | --- | --- |
| Athlete code | AthleteID | Text |
| Athlete name/check-in title | Name | Title |
| Submitted at | Date | Date |
| Bodyweight | Weight | Number |
| Sleep | Sleep Score | Number |
| Energy | Energy | Number |
| Stress | Stress | Number |
| Soreness | Soreness | Number |
| Session title | Session | Text |
| Motivation | Motivation | Number |
| Session RPE | RPE | Number |
| Pain flag | Pain | Checkbox |
| Notes | Notes | Text |
| Coach alert | Coach Alert | Select: Normal, Watch, Coach Review |

I extended the database with these premium fields:

- `Session`
- `Motivation`
- `RPE`
- `Pain`
- `Coach Alert`

## Activation

The root athlete URL opens the portal:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

The portal stores check-ins locally if `CHECKIN_DATABASE_ID` is not configured yet.

## Coach Alert Logic

The check-in is marked `Coach Review` when the athlete flags pain or injury.

It is marked `Watch` when:

- Energy is 3/10 or lower
- Motivation is 3/10 or lower
- Stress is 8/10 or higher
- Soreness is 8/10 or higher

Otherwise it is marked `Normal`.
