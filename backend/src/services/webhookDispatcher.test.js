const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();
const {
  hmacSignature,
  MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
  MAX_DELIVERY_ATTEMPTS,
} = require('./webhookDispatcher');

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(ok, status, body) {
  return { ok, status, text: async () => body };
}

function makeDb({ deliverableRows = [], campaignRows = [] } = {}) {
  const seen = { userWebhookIds: [], campaignWebhookIds: [], updates: [], userPollerSql: null, campaignPollerSql: null };
  const userDelivery = {
    id: 'd-user-1',
    attempt_count: 1,
    status: 'delivering',
    payload: { campaign_id: 'c-1', status: 'funded' },
    event_type: 'campaign.funded',
    url: 'https://hooks.example.test/user',
    secret: 'whsec_user',
    revoked_at: null,
  };
  const campaignDelivery = {
    id: 'd-campaign-1',
    attempt_count: 1,
    status: 'delivering',
    payload: { campaign_id: 'c-1', status: 'funded' },
    event: 'campaign.funded',
    url: 'https://hooks.example.test/campaign',
    secret: 'whsec_campaign',
    active: true,
  };

  const query = async (text) => {
    if (text.includes('FROM campaign_webhook_deliveries') && !text.includes('JOIN campaign_webhooks')) {
      seen.campaignPollerSql = seen.campaignPollerSql || text;
      return { rows: campaignRows };
    }
    if (text.includes('FROM campaign_webhook_deliveries d')) {
      return { rows: [{ id: 'd-campaign-1', ...campaignDelivery }] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'delivering'")) {
      seen.campaignWebhookIds.push('d-campaign-1');
      return { rows: [] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'delivered'")) {
      seen.updates.push({ kind: 'campaign_delivered', sql: text });
      return { rows: [] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'retrying'")) {
      seen.updates.push({ kind: 'campaign_retrying', sql: text });
      return { rows: [] };
    }
    if (text.includes('campaign_webhook_deliveries') && text.includes("status = 'failed'")) {
      seen.updates.push({ kind: 'campaign_failed', sql: text });
      return { rows: [] };
    }
    if (text.includes('FROM webhook_deliveries') && !text.includes('JOIN webhooks')) {
      seen.userPollerSql = seen.userPollerSql || text;
      return { rows: deliverableRows };
    }
    if (text.includes('FROM webhook_deliveries d')) {
      return { rows: [{ id: 'd-user-1', ...userDelivery }] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'delivering'")) {
      seen.userWebhookIds.push('d-user-1');
      return { rows: [] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'delivered'")) {
      seen.updates.push({ kind: 'user_delivered', sql: text });
      return { rows: [] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'retrying'")) {
      seen.updates.push({ kind: 'user_retrying', sql: text });
      return { rows: [] };
    }
    if (text.includes('webhook_deliveries') && text.includes("status = 'failed'")) {
      seen.updates.push({ kind: 'user_failed', sql: text });
      return { rows: [] };
    }
    return { rows: [] };
  };

  return { query, seen, userDelivery, campaignDelivery };
}

function loadDispatcher(db) {
  return proxyquire('./webhookDispatcher', { '../config/database': db });
}

beforeEach(() => {
  globalThis.fetch = undefined;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});

const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;

test('HMAC-SHA256 signature matches Node crypto verify pattern', () => {
  const secret = 'whsec_testsecret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = hmacSignature(secret, body);
  const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(sig, expected);
});

test('poller selects expired delivering rows via a lease (make_interval)', () => {
  const db = makeDb();
  const dispatcher = loadDispatcher(db);
  globalThis.fetch = async () => jsonResponse(true, 200, 'ok');

  return dispatcher.processDueRetries().then(() => {
    assert.ok(db.seen.userPollerSql, 'poller SQL was not issued');
    assert.match(db.seen.userPollerSql, /status = 'delivering'/);
    assert.match(db.seen.userPollerSql, /make_interval\(secs => \$1\)/);
  });
});

test('delivering row whose lease expired is re-delivered after simulated crash', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://hooks.example.test/user');
  assert.match(fetchCalls[0].opts.headers['X-CrowdPay-Delivery-Id'], /d-user-1/);
  assert.match(fetchCalls[0].opts.headers['X-CrowdPay-Signature'], /^sha256=/);
  assert.ok(db.seen.updates.some((u) => u.kind === 'user_delivered'));
});

test('rows still within the delivery lease are not re-picked', async () => {
  const db = makeDb({ deliverableRows: [] });
  const dispatcher = loadDispatcher(db);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls, 0);
});

test('fetch failure after lease re-pick moves the row back to retrying with backoff', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  const dispatcher = loadDispatcher(db);
  globalThis.fetch = async () => jsonResponse(false, 500, 'internal error');
  globalThis.setTimeout = () => 0;

  await dispatcher.processDueRetries();

  const retryUpdate = db.seen.updates.find((u) => u.kind === 'user_retrying');
  assert.ok(retryUpdate, 'expected a retrying update after a 500');
  assert.match(retryUpdate.sql, /next_retry_at = \$\d/);
  assert.match(retryUpdate.sql, /last_error = \$\d/);
});

test('delivering row already at max attempts fails without refetching', async () => {
  const db = makeDb({ deliverableRows: [{ id: 'd-user-1' }] });
  db.userDelivery.attempt_count = MAX_DELIVERY_ATTEMPTS;
  const dispatcher = loadDispatcher(db);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueRetries();

  assert.equal(fetchCalls, 0);
  assert.ok(db.seen.updates.some((u) => u.kind === 'user_failed'));
});

test('campaign poller resurrects a stuck delivering delivery after lease expiry', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  const dispatcher = loadDispatcher(db);
  const fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueCampaignWebhookRetries();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://hooks.example.test/campaign');
  assert.ok(db.seen.updates.some((u) => u.kind === 'campaign_delivered'));

  assert.ok(db.seen.campaignPollerSql, 'campaign poller SQL was not issued');
  assert.match(db.seen.campaignPollerSql, /status = 'delivering'/);
  assert.match(db.seen.campaignPollerSql, /make_interval\(secs => \$1\)/);
});

test('campaign delivery fetch failure schedules a campaign retry', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  const dispatcher = loadDispatcher(db);
  globalThis.fetch = async () => jsonResponse(false, 404, 'not found');
  globalThis.setTimeout = () => 0;

  await dispatcher.processDueCampaignWebhookRetries();

  assert.ok(db.seen.updates.some((u) => u.kind === 'campaign_retrying'));
});

test('campaign delivery exceeding max attempts fails', async () => {
  const db = makeDb({ campaignRows: [{ id: 'd-campaign-1' }] });
  db.campaignDelivery.attempt_count = MAX_CAMPAIGN_DELIVERY_ATTEMPTS;
  const dispatcher = loadDispatcher(db);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse(true, 200, 'ok');
  };

  await dispatcher.processDueCampaignWebhookRetries();

  assert.equal(fetchCalls, 0);
  assert.ok(db.seen.updates.some((u) => u.kind === 'campaign_failed'));
});