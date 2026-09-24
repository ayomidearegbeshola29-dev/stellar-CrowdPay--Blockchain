const crypto = require('crypto');
const db = require('../config/database');

const WEBHOOK_EVENTS = {
  CAMPAIGN_FUNDED: 'campaign.funded',
  CAMPAIGN_FAILED: 'campaign.failed',
  CONTRIBUTION_RECEIVED: 'contribution.received',
  CONTRIBUTION_INDEXED: 'contribution.indexed', // campaign-level event
  MILESTONE_APPROVED: 'milestone.approved',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
};

const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_CAMPAIGN_DELIVERY_ATTEMPTS = 3;

// A delivery flips to 'delivering' the moment the HTTP request starts. If the
// process crashes mid-request the row can be stuck in 'delivering' forever
// (the in-process retry timer dies with it). The poller treats a 'delivering'
// row whose lease has expired as abandoned and re-queues it. Kept comfortably
// above the 9s fetch timeout so live in-flight deliveries are never double-picked.
const DELIVERY_LEASE_SECONDS = 25;

function hmacSignature(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

function backoffMs(attemptNumber) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attemptNumber - 1));
}

function backoffMsForCampaign(attemptNumber) {
  // Campaign webhooks: exponential backoff (5s, 30s, 5min)
  const delays = [5000, 30000, 300000];
  return delays[Math.min(attemptNumber - 1, delays.length - 1)];
}

/** Queue outbound webhook deliveries for every active endpoint owned by `ownerUserId`. */
async function emitWebhookEventForUser(ownerUserId, eventType, payload) {
  if (!ownerUserId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM webhooks
     WHERE user_id = $1 AND revoked_at IS NULL AND $2 = ANY(events)`,
    [ownerUserId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processDelivery(deliveryId).catch((err) =>
        console.error(`[webhooks] delivery ${deliveryId}:`, err.message)
      );
    });
  }
}

async function processDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event_type,
            w.url, w.secret, w.revoked_at
     FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (row.revoked_at) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook revoked', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const sig = hmacSignature(row.secret, bodyUtf8);

  await db.query(
    `UPDATE webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  let responseText = '';
  try {
    res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Event': row.event_type,
        'X-CrowdPay-Delivery-Id': deliveryId,
      },
      body: bodyUtf8,
      signal: AbortSignal.timeout(9000),
    });
    responseText = await res.text();
  } catch (err) {
    await scheduleRetry(deliveryId, nextAttempt, err.message || String(err), null, null);
    return;
  }

  const snippet = responseText.slice(0, 512);
  if (res.ok) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', response_status = $2, response_body_snippet = $3,
           delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status, snippet]
    );
    return;
  }

  await scheduleRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status,
    snippet
  );
}

async function scheduleRetry(deliveryId, attemptJustUsed, errMsg, httpStatus, snippet) {
  if (attemptJustUsed >= MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, response_body_snippet = $4, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus, snippet]
    );
    return;
  }

  const delay = backoffMs(attemptJustUsed);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, response_body_snippet = $5, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus, snippet]
  );

  setTimeout(() => {
    processDelivery(deliveryId).catch((err) =>
      console.error(`[webhooks] retry ${deliveryId}:`, err.message)
    );
  }, delay);
}

async function processDueRetries() {
  const { rows } = await db.query(
    `SELECT id FROM webhook_deliveries
     WHERE (status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
        OR (status = 'delivering' AND updated_at <= NOW() - make_interval(secs => $1))
     LIMIT 25`,
    [DELIVERY_LEASE_SECONDS]
  );
  for (const r of rows) {
    await processDelivery(r.id).catch((err) =>
      console.error(`[webhooks] poller ${r.id}:`, err.message)
    );
  }
}

/** Queue outbound webhook deliveries for campaign webhooks */
async function emitWebhookEventForCampaign(campaignId, eventType, payload) {
  if (!campaignId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM campaign_webhooks
     WHERE campaign_id = $1 AND active = TRUE AND $2 = ANY(events)`,
    [campaignId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO campaign_webhook_deliveries (webhook_id, event, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processCampaignWebhookDelivery(deliveryId).catch((err) =>
        console.error(`[campaign-webhooks] delivery ${deliveryId}:`, err.message)
      );
    });
  }
}

async function processCampaignWebhookDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.attempt_count, d.status, d.payload, d.event,
            w.url, w.secret, w.active
     FROM campaign_webhook_deliveries d
     JOIN campaign_webhooks w ON w.id = d.webhook_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (!row.active) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = 'webhook disabled', updated_at = NOW() WHERE id = $1`,
      [deliveryId]
    );
    return;
  }
  if (row.status === 'delivered') return;

  const nextAttempt = row.attempt_count + 1;
  if (nextAttempt > MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE campaign_webhook_deliveries SET status = 'failed', last_error = $2, failed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [deliveryId, 'max delivery attempts exceeded']
    );
    return;
  }

  const bodyUtf8 = JSON.stringify(row.payload);
  const sig = hmacSignature(row.secret, bodyUtf8);

  await db.query(
    `UPDATE campaign_webhook_deliveries SET attempt_count = $2, status = 'delivering', updated_at = NOW() WHERE id = $1`,
    [deliveryId, nextAttempt]
  );

  let res;
  let responseText = '';
  try {
    res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': `sha256=${sig}`,
        'X-CrowdPay-Event': row.event,
        'X-CrowdPay-Delivery-Id': deliveryId,
      },
      body: bodyUtf8,
      signal: AbortSignal.timeout(9000),
    });
    responseText = await res.text();
  } catch (err) {
    await scheduleCampaignWebhookRetry(deliveryId, nextAttempt, err.message || String(err), null);
    return;
  }

  if (res.ok) {
    await db.query(
      `UPDATE campaign_webhook_deliveries
       SET status = 'delivered', response_status = $2, delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, res.status]
    );
    return;
  }

  await scheduleCampaignWebhookRetry(
    deliveryId,
    nextAttempt,
    `HTTP ${res.status}`,
    res.status
  );
}

async function scheduleCampaignWebhookRetry(deliveryId, attemptJustUsed, errMsg, httpStatus) {
  if (attemptJustUsed >= MAX_CAMPAIGN_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE campaign_webhook_deliveries
       SET status = 'failed', last_error = $2, response_status = $3, failed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, errMsg, httpStatus]
    );
    return;
  }

  const delay = backoffMsForCampaign(attemptJustUsed);
  const nextAt = new Date(Date.now() + delay);
  await db.query(
    `UPDATE campaign_webhook_deliveries
     SET status = 'retrying', next_retry_at = $2, last_error = $3,
         response_status = $4, updated_at = NOW()
     WHERE id = $1`,
    [deliveryId, nextAt.toISOString(), errMsg, httpStatus]
  );

  setTimeout(() => {
    processCampaignWebhookDelivery(deliveryId).catch((err) =>
      console.error(`[campaign-webhooks] retry ${deliveryId}:`, err.message)
    );
  }, delay);
}

async function processDueCampaignWebhookRetries() {
  const { rows } = await db.query(
    `SELECT id FROM campaign_webhook_deliveries
     WHERE (status = 'retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW())
        OR (status = 'delivering' AND updated_at <= NOW() - make_interval(secs => $1))
     LIMIT 25`,
    [DELIVERY_LEASE_SECONDS]
  );
  for (const r of rows) {
    await processCampaignWebhookDelivery(r.id).catch((err) =>
      console.error(`[campaign-webhooks] poller ${r.id}:`, err.message)
    );
  }
}

function startWebhookRetryPoller() {
  setInterval(() => {
    processDueRetries().catch((e) => console.error('[webhooks] poller:', e.message));
    processDueCampaignWebhookRetries().catch((e) => console.error('[campaign-webhooks] poller:', e.message));
  }, 5000);
}

module.exports = {
  WEBHOOK_EVENTS,
  ALL_WEBHOOK_EVENTS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
  hmacSignature,
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  processDelivery,
  processCampaignWebhookDelivery,
  processDueRetries,
  processDueCampaignWebhookRetries,
  startWebhookRetryPoller,
};
