# Premium Dashboard Rollout

This rollout adds the product layer that makes the athlete portal feel like a coached service rather than a data viewer.

## New Experience

The premium dashboard adds:

- Today's training card
- Weekly coach-focus area
- Readiness score
- Athlete check-in
- Post-session RPE
- Pain/injury flag
- Coach alert state
- Local fallback saving when Notion is not configured

## Files

- `public/premium.html`: premium shell used by the root route
- `public/premium-dashboard.js`: optional in-app command center module for a future direct `index.html` integration
- `api/checkin.js`: writes athlete check-ins into a dedicated Notion database
- `vercel.json`: routes `/` to `premium.html`, while preserving `/index.html` as the original portal

## Vercel Environment Variables

Add these before enabling Notion-backed check-ins:

```text
NOTION_TOKEN=your_rotated_notion_token
ALLOWED_ORIGINS=https://your-portal-domain.vercel.app
CHECKIN_DATABASE_ID=your_checkin_database_id
```

## Notion Check-In Database Properties

Create a Notion database with these property names and types:

| Property | Type |
| --- | --- |
| Name | Title |
| Athlete Code | Text |
| Athlete | Text |
| Date | Date |
| Session | Text |
| Energy | Number |
| Sleep | Number |
| Soreness | Number |
| Motivation | Number |
| RPE | Number |
| Pain | Checkbox |
| Notes | Text |
| Coach Alert | Select: Normal, Watch, Coach Review |

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
- Soreness is 8/10 or higher

Otherwise it is marked `Normal`.
