// ── CONFIG ────────────────────────────────────────────────────────────────────
// Public client configuration. These values are visible in the browser by design:
// - Notion database IDs are identifiers, not write credentials.
// - Supabase anon/publishable keys rely on RLS policies for access control.
// - Cloudinary unsigned upload presets must be locked down in Cloudinary.
// Keep write-capable secrets in Vercel env vars only (NOTION_TOKEN,
// SUPABASE_SERVICE_KEY, CLOUDINARY_API_SECRET, CRON_SECRET).
const CALENDAR_DB        = '0b85a96cc70b836898fd013e0e15c4f2';
const ATHLETE_DB         = '4a25a96cc70b82ffa6790139eaa8b458';
const RUN_DB             = '3465a96cc70b80e1aa77d484b9dc197c';
const WEEKLY_KM_DB       = 'PASTE_YOUR_WEEKLY_KM_DATABASE_ID_HERE';
const NUTRITION_DB       = '3405a96cc70b80de9221c2a40653277c';
const DAILY_BODY_DB      = '3405a96cc70b80a4b1b9cf5b9c236f18';
const ATHLETE_SESSION_TRACKER_DB = 'PASTE_YOUR_ATHLETE_SESSION_TRACKER_DB_ID_HERE';
// Writes migrated off Make → single Vercel serverless function /api/write (routed by payload.type)
const WEBHOOK            = '/api/write';
const CHECKIN_WEBHOOK    = '/api/write';
const DAILY_BODY_WEBHOOK = '/api/write';
const DAILY_NUT_WEBHOOK  = '/api/write';
const GOALS_WEBHOOK      = '/api/write';
const CLOUDINARY_CLOUD   = 'dtkpg96ci';
const CLOUDINARY_PRESET  = 'dp_progress';
const SUPABASE_URL       = 'https://rugdupplsswxmpoudhpv.supabase.co';
const SUPABASE_ANON_KEY  = 'sb_publishable_KJU_GYqUOwthiLo5WQjfog_MLaVKw5R';
var GYM_KEYS = ['Upper A','Upper B','Lower A','Lower B']; // extended at runtime from Supabase workout_splits
const DAYS     = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
