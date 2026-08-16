#!/usr/bin/env node
/**
 * Manage the Strava push subscription (webhook).
 *
 *   node scripts/strava-subscription.mjs view
 *   node scripts/strava-subscription.mjs create
 *   node scripts/strava-subscription.mjs delete <id>
 *
 * An application may hold EXACTLY ONE subscription, and it covers every athlete
 * who has authorised the app. So this is a one-time setup, not a per-athlete
 * step — and `create` will fail while another subscription exists, which is why
 * `view` comes first in the runbook.
 *
 * Requires in the environment (a local .env is fine — never commit it):
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   STRAVA_WEBHOOK_VERIFY_TOKEN   must match the deployed function's value
 *   PORTAL_URL                    e.g. https://dp-athlete-portal.vercel.app
 *
 * IMPORTANT: the callback must already be deployed and publicly reachable before
 * you run `create`. Strava performs the GET validation handshake synchronously
 * during the create call and gives it two seconds — pointing at a preview URL
 * behind Vercel's deployment protection is the usual reason this fails.
 */

const API = (process.env.STRAVA_API_BASE || 'https://www.strava.com/api/v3').replace(/\/+$/, '');
const ENDPOINT = `${API}/push_subscriptions`;

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function credentials() {
  return {
    client_id: required('STRAVA_CLIENT_ID'),
    client_secret: required('STRAVA_CLIENT_SECRET'),
  };
}

async function view() {
  const params = new URLSearchParams(credentials());
  const res = await fetch(`${ENDPOINT}?${params}`);
  const body = await res.text();
  if (!res.ok) {
    console.error(`View failed (${res.status}): ${body}`);
    process.exit(1);
  }
  const subscriptions = JSON.parse(body);
  if (!subscriptions.length) {
    console.log('No subscription exists. Run `create` once the callback is deployed.');
    return;
  }
  for (const sub of subscriptions) {
    console.log(`id=${sub.id}\n  callback_url=${sub.callback_url}\n  created_at=${sub.created_at}`);
  }
  console.log('\nSet STRAVA_WEBHOOK_SUBSCRIPTION_ID in Vercel to the id above so the');
  console.log('function rejects events from any other subscription.');
}

async function create() {
  const callbackUrl = `${required('PORTAL_URL').replace(/\/+$/, '')}/api/strava-webhook`;
  const body = new URLSearchParams({
    ...credentials(),
    callback_url: callbackUrl,
    verify_token: required('STRAVA_WEBHOOK_VERIFY_TOKEN'),
  });

  console.log(`Creating subscription → ${callbackUrl}`);
  console.log('Strava will now GET that URL and expect hub.challenge echoed within 2s...');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();

  if (!res.ok) {
    console.error(`\nCreate failed (${res.status}): ${text}`);
    console.error('\nMost common causes, in order:');
    console.error('  1. The callback is not deployed yet, or is behind Vercel deployment protection.');
    console.error('  2. STRAVA_WEBHOOK_VERIFY_TOKEN here does not match the deployed value.');
    console.error('  3. A subscription already exists — run `view`, then `delete <id>`.');
    process.exit(1);
  }

  const sub = JSON.parse(text);
  console.log(`\nCreated. id=${sub.id}`);
  console.log(`Now set STRAVA_WEBHOOK_SUBSCRIPTION_ID=${sub.id} in Vercel and redeploy.`);
}

async function remove(id) {
  if (!id) {
    console.error('Usage: node scripts/strava-subscription.mjs delete <id>');
    process.exit(1);
  }
  const params = new URLSearchParams(credentials());
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(id)}?${params}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    console.error(`Delete failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Deleted subscription ${id}.`);
}

const [command, argument] = process.argv.slice(2);
const commands = { view, create, delete: () => remove(argument) };

if (!commands[command]) {
  console.error('Usage: node scripts/strava-subscription.mjs <view|create|delete <id>>');
  process.exit(1);
}

commands[command]().catch((error) => {
  console.error(error);
  process.exit(1);
});
