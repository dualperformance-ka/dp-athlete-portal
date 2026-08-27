import { patch, select } from './supabase-rest.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validNotificationId(id) {
  if (!UUID.test(String(id || ''))) {
    const error = new Error('A valid notification id is required');
    error.status = 400;
    throw error;
  }
  return String(id);
}

export async function listInbox(code, dependencies = {}) {
  const selectRows = dependencies.select || select;
  const [rows, unreadRows] = await Promise.all([
    selectRows('athlete_notifications', {
      athlete_code: `eq.${code}`,
      dismissed_at: 'is.null',
      select: 'id,type,title,body,url,created_at,read_at,pushed_at',
      order: 'created_at.desc',
      limit: '50',
    }),
    selectRows('athlete_notifications', {
      athlete_code: `eq.${code}`,
      dismissed_at: 'is.null',
      read_at: 'is.null',
      select: 'id',
      limit: '1000',
    }),
  ]);
  const notifications = Array.isArray(rows) ? rows : [];
  return { notifications, unread: Array.isArray(unreadRows) ? unreadRows.length : 0 };
}

async function refreshedInbox(code, dependencies) {
  const listRows = dependencies.listInbox || listInbox;
  return listRows(code, dependencies);
}

export async function markInboxRead(code, id, dependencies = {}) {
  const patchRows = dependencies.patch || patch;
  await patchRows('athlete_notifications', {
    id: `eq.${validNotificationId(id)}`,
    athlete_code: `eq.${code}`,
    dismissed_at: 'is.null',
  }, { read_at: new Date().toISOString() });
  return refreshedInbox(code, dependencies);
}

export async function dismissInboxNotification(code, id, dependencies = {}) {
  const patchRows = dependencies.patch || patch;
  const dismissedAt = new Date().toISOString();
  await patchRows('athlete_notifications', {
    id: `eq.${validNotificationId(id)}`,
    athlete_code: `eq.${code}`,
    dismissed_at: 'is.null',
  }, { dismissed_at: dismissedAt, read_at: dismissedAt });
  return refreshedInbox(code, dependencies);
}

export async function clearInbox(code, dependencies = {}) {
  const patchRows = dependencies.patch || patch;
  const dismissedAt = new Date().toISOString();
  await patchRows('athlete_notifications', {
    athlete_code: `eq.${code}`,
    dismissed_at: 'is.null',
  }, { dismissed_at: dismissedAt, read_at: dismissedAt });
  return refreshedInbox(code, dependencies);
}
