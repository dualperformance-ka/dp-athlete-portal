# Premium Dashboard Rollout

This rollout adds the product layer that makes the athlete portal feel like a coached service rather than a data viewer.

## New Experience

The premium dashboard module adds:

- Today's training card
- Weekly coach-focus area
- Readiness score
- Athlete check-in
- Post-session RPE
- Pain/injury flag
- Coach alert state
- Local fallback saving when Notion is not configured

## Files

- `public/premium-dashboard.js`: client-side premium command center and check-in flow
- `api/checkin.js`: writes athlete check-ins into a dedicated Notion database

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

## Enable The Dashboard

Add this script before the closing `</body>` tag in `public/index.html`:

```html
<script src="/premium-dashboard.js"></script>
```

The module is defensive: it waits for the existing portal UI, injects itself into the active tab, and saves locally if the Notion check-in API is not configured yet.

## Coach Alert Logic

The check-in is marked `Coach Review` when the athlete flags pain or injury.

It is marked `Watch` when:

- Energy is 3/10 or lower
- Motivation is 3/10 or lower
- Soreness is 8/10 or higher

Otherwise it is marked `Normal`.
