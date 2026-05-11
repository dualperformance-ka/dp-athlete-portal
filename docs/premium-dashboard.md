# Premium Dashboard Rollout

This rollout adds the product layer that makes the athlete portal feel like a coached service rather than a data viewer.

## New Experience

The premium dashboard adds:

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

- `public/premium.html`: premium shell used by the root route
- `public/premium-dashboard.js`: optional in-app command center module for a future direct `index.html` integration
- `api/checkin.js`: writes athlete check-ins into the BODY check-in database
- `vercel.json`: routes `/` to `premium.html`, while preserving `/index.html` as the original portal

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

The root athlete URL now opens the premium shell automatically:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

The original portal remains available at:

```text
https://your-portal.vercel.app/index.html?code=ATHLETE_CODE
```

The premium shell wraps the current portal, reads the visible session when available, and stores check-ins locally if `CHECKIN_DATABASE_ID` is not configured yet.

## Optional Direct Integration

For a future cleanup pass, add this script before the closing `</body>` tag in `public/index.html`:

```html
<script src="/premium-dashboard.js"></script>
```

That embeds the command center directly into the existing portal instead of using the shell. The root shell was used first because `public/index.html` is a very large single file with embedded image data, so a small routing wrapper is safer than replacing the whole file remotely.

## Coach Alert Logic

The check-in is marked `Coach Review` when the athlete flags pain or injury.

It is marked `Watch` when:

- Energy is 3/10 or lower
- Motivation is 3/10 or lower
- Stress is 8/10 or higher
- Soreness is 8/10 or higher

Otherwise it is marked `Normal`.
