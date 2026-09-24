const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

// wallet route/encryption tests decrypt the stored campaign secret, so a stable
// server-side key must be present (mirrors how provider env vars are seeded).
process.env.WALLET_ENCRYPTION_KEY =
  process.env.WALLET_ENCRYPTION_KEY ||
  '0000000000000000000000000000000000000000000000000000000000000000';
// campaigns.js pulls in sorobanService -> config/stellar, which builds the USDC asset.
process.env.USDC_ISSUER =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function buildApp({
  queryImpl,
  buildWithdrawalTransactionImpl,
  insertWithdrawalPendingSignaturesImpl,
  queueFailedCampaignRefundsImpl,
  authUser,
  campaignStatusImpl,
}) {
  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': campaignStatusImpl || {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds:
        queueFailedCampaignRefundsImpl ||
        (async () => ({ refundsCreated: 0, refunds: [] })),
    },
    '../config/database': {
      query: queryImpl,
      connect: async () => ({ query: queryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: buildWithdrawalTransactionImpl,
    },
    '../services/ledgerMonitor': {
      watchCampaignWallet: async () => {},
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: insertWithdrawalPendingSignaturesImpl,
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = authUser || { userId: 'platform-1', role: 'admin' };
        next();
      },
      requireRole: () => (req, _res, next) => {
        next();
      },
      optionalAuth: (req, _res, next) => {
        req.user = authUser || undefined;
        next();
      },
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

test('GET /api/campaigns/:id/embed preserves UUIDs and returns live widget data', async () => {
  let queryParams;
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('FROM campaigns') && text.includes('backer_count')) {
        queryParams = params;
        return {
          rows: [{
            id: '11111111-1111-1111-1111-111111111111',
            title: 'Community fund',
            description: 'A project',
            target_amount: '100',
            raised_amount: '25',
            asset_type: 'XLM',
            status: 'active',
            backer_count: 2,
          }],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app).get('/api/campaigns/11111111-1111-1111-1111-111111111111/embed');

  assert.equal(response.status, 200);
  assert.deepEqual(queryParams, ['11111111-1111-1111-1111-111111111111']);
  assert.equal(response.body.progress_percentage, 25);
  assert.equal(response.body.contributor_count, 2);
});

test('GET /api/campaigns/:id/analytics returns documented public analytics', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id FROM campaigns')) return { rows: [{ id: 'camp-1' }] };
      if (text.includes('DATE(created_at)')) return { rows: [{ day: '2026-09-24', contribution_count: '1', total_amount: '5', asset: 'XLM' }] };
      if (text.includes('COALESCE(source_asset')) return { rows: [{ paid_with: 'XLM', count: '1', total_sent: '5' }] };
      if (text.includes('SUM(amount) AS total')) return { rows: [{ sender_public_key: 'G...', total: '5', times: '1' }] };
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app).get('/api/campaigns/camp-1/analytics');

  assert.equal(response.status, 200);
  assert.equal(response.body.dailyTotals.length, 1);
  assert.equal(response.body.assetBreakdown[0].paid_with, 'XLM');
  assert.equal(response.body.topContributors[0].times, '1');
});

test('POST /api/campaigns/cron/fail-expired returns failed and funded campaigns', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
    campaignStatusImpl: {
      refreshActiveCampaignStatuses: async () => ({
        failed: [{
          id: 'c-1',
          title: 'Campaign 1',
          target_amount: '100',
          raised_amount: '50',
          deadline: '2026-04-23',
          status: 'failed',
        }],
        funded: [{ id: 'c-2', title: 'Funded', status: 'funded' }],
      }),
    },
  });

  const response = await request(app)
    .post('/api/campaigns/cron/fail-expired')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.failedCampaigns.length, 1);
  assert.equal(response.body.fundedCampaigns.length, 1);
});

test('POST /api/campaigns blocks unverified creators when KYC gate is enabled', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status, email_verified FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'pending', email_verified: true }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Verified only', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'KYC_REQUIRED');
});

test('POST /api/campaigns allows creation when KYC gate is disabled', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status, email_verified FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'unverified', email_verified: true }] };
      }
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Dev campaign',
              asset_type: 'USDC',
              creator_id: 'creator-1',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Dev campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'campaign-1');
});

test('POST /api/campaigns persists an encrypted campaign wallet secret', async (t) => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';

  let insertParams;
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status, email_verified FROM users')) {
        return { rows: [{ wallet_public_key: 'GCREATOR', kyc_status: 'unverified', email_verified: true }] };
      }
      if (text.includes('INSERT INTO campaigns')) {
        insertParams = params;
        return { rows: [{ id: 'campaign-1', creator_id: 'creator-1' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Dev campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 201);
  assert.ok(insertParams, 'campaign INSERT params were captured');
  assert.equal(insertParams[0], 'Dev campaign');
  assert.equal(insertParams[4], 'GPK');
  assert.equal(typeof insertParams[5], 'string', 'wallet_secret_encrypted must be stored');
  assert.notEqual(insertParams[5], 'S', 'secret must be stored encrypted, never in plaintext');
  assert.equal(
    require('../services/walletService').decryptSecret(insertParams[5]),
    'S',
    'stored secret must round-trip back to the wallet master secret'
  );
});

test('POST /api/campaigns returns 500 and logs orphaned wallet when DB insert fails', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT email, wallet_public_key, kyc_status, email_verified FROM users')) {
        return { rows: [{ email: 'creator@test.com', wallet_public_key: 'GCREATOR', kyc_status: 'verified', email_verified: true }] };
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO campaigns')) {
        throw new Error('unique constraint violation');
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Broken campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 500);
  assert.match(response.body.error, /contact support/i);
});

test('POST /api/campaigns returns 400 with validation errors for invalid payload', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: '', target_amount: -5, asset_type: 'INVALID' });

  assert.equal(response.status, 400);
  assert.ok(Array.isArray(response.body.errors));
  assert.ok(response.body.errors.length >= 1);
});

test('POST /api/campaigns/:id/trigger-refunds creates refund requests for contributions', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT id, wallet_public_key, status FROM campaigns')) {
        return { rows: [{ id: 'c-1', wallet_public_key: 'GPK', status: 'failed' }] };
      }
      return { rows: [] };
    },
    queueFailedCampaignRefundsImpl: async (campaignId, actorUserId) => {
      assert.equal(campaignId, 'c-1');
      assert.equal(actorUserId, 'platform-1');
      return {
        refundsCreated: 1,
        refunds: [{ contribution_id: 'contrib-1', refund_request_id: 'wr-1' }],
      };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/c-1/trigger-refunds')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 201);
  assert.equal(response.body.refundsCreated, 1);
});

test('GET /api/campaigns supports search, asset filter, and sort', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          {
            id: 'camp-1',
            title: 'Solar panels',
            description: 'Clean energy',
            asset_type: 'USDC',
            status: 'active',
            raised_amount: '80',
            target_amount: '100',
          },
        ],
      };
    },
  });

  const response = await request(app).get(
    '/api/campaigns?search=solar&asset=USDC&sort=closest_to_goal'
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.campaigns.length, 1);
  const listQuery = queries.find((q) => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /ILIKE/i);
  assert.match(listQuery.text, /raised_amount \/ NULLIF/i);
  assert.ok(listQuery.params.includes('%solar%'));
  assert.ok(listQuery.params.includes('USDC'));
});

test('GET /api/campaigns accepts every valid status and passes it to the filter', async () => {
  const { VALID_CAMPAIGN_STATUSES } = require('../middleware/validation');
  for (const status of VALID_CAMPAIGN_STATUSES) {
    const queries = [];
    const app = buildApp({
      queryImpl: async (text, params) => {
        queries.push({ text, params });
        return text.includes('COUNT(*)') ? { rows: [{ total: 0 }] } : { rows: [] };
      },
    });
    const response = await request(app).get(`/api/campaigns?status=${status}`);
    assert.equal(response.status, 200, `status ${status} should be accepted`);
    assert.ok(queries.some((q) => q.params && q.params.includes(status)));
  }
});

test('GET /api/campaigns rejects an unknown status', async () => {
  const app = buildApp({ queryImpl: async () => ({ rows: [] }) });
  const response = await request(app).get('/api/campaigns?status=bogus');
  assert.equal(response.status, 400);
});

test('GET /api/campaigns applies a distinct ORDER BY for every valid sort', async () => {
  const { VALID_ORDER_BY } = require('../middleware/validation');
  const seen = new Set();
  for (const sort of VALID_ORDER_BY) {
    let listQuery;
    const app = buildApp({
      queryImpl: async (text) => {
        if (text.includes('ORDER BY')) listQuery = text;
        return text.includes('COUNT(*)') ? { rows: [{ total: 0 }] } : { rows: [] };
      },
    });
    const response = await request(app).get(`/api/campaigns?sort=${sort}`);
    assert.equal(response.status, 200, `sort ${sort} should be accepted`);
    seen.add(listQuery.match(/ORDER BY([\s\S]*?)LIMIT/)[1].trim());
    if (sort === 'trending') assert.match(listQuery, /INTERVAL '7 days'/);
  }
  assert.equal(seen.size, VALID_ORDER_BY.length, 'every sort must map to its own clause');
});

test('GET /api/campaigns/:id is read-only and does not mutate status', async () => {
  let refreshCalled = false;
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('SELECT *,')) {
        return {
          rows: [
            {
              id: 'c4a96b7d-6dc2-48ec-b12d-d602cb11b987',
              creator_id: 'creator-1',
              title: 'Read Only Test',
              status: 'active',
              target_amount: '100',
              raised_amount: '50',
            },
          ],
        };
      }
      return { rows: [] };
    },
    campaignStatusImpl: {
      refreshCampaignStatus: async () => {
        refreshCalled = true;
        return { failed: null, funded: null };
      },
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
  });

  const response = await request(app).get('/api/campaigns/c4a96b7d-6dc2-48ec-b12d-d602cb11b987');
  assert.equal(response.status, 200);
  assert.equal(refreshCalled, false, 'GET must never trigger refreshCampaignStatus write side-effects');
});

test('POST /api/campaigns/:id/refresh-status allows authorized creator or admin', async () => {
  let refreshCalled = false;
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text) => {
      if (text.includes('SELECT creator_id, status FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1', status: 'active' }] };
      }
      if (text.includes('SELECT * FROM campaigns')) {
        return { rows: [{ id: 'c4a96b7d-6dc2-48ec-b12d-d602cb11b987', status: 'funded' }] };
      }
      return { rows: [] };
    },
    campaignStatusImpl: {
      refreshCampaignStatus: async () => {
        refreshCalled = true;
        return { funded: 'c4a96b7d-6dc2-48ec-b12d-d602cb11b987' };
      },
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
  });

  const response = await request(app).post('/api/campaigns/c4a96b7d-6dc2-48ec-b12d-d602cb11b987/refresh-status');
  assert.equal(response.status, 200);
  assert.equal(refreshCalled, true, 'Authorized POST should refresh campaign status');
});


// ---------------------------------------------------------------------------
// Issue #20: Campaign invite acceptance must be bound to invited email
// ---------------------------------------------------------------------------

test('POST /campaigns/:id/members/accept rejects token with mismatched email (403)', async () => {
  const app = buildApp({
    authUser: { userId: 'other-user', role: 'contributor' },
    queryImpl: async (text) => {
      // invite lookup
      if (text.includes('FROM campaign_members') && text.includes('invite_token')) {
        return {
          rows: [{
            id: 'member-1',
            accepted_at: null,
            email: 'alice@example.com',
            invite_expires_at: new Date(Date.now() + 86400000), // 1 day from now
          }],
        };
      }
      // user email lookup
      if (text.includes('SELECT email FROM users')) {
        return { rows: [{ email: 'bob@example.com' }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/members/accept')
    .set('Authorization', 'Bearer token')
    .send({ token: 'validtoken123' });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /different email/i);
});

test('POST /campaigns/:id/members/accept succeeds when emails match', async () => {
  const app = buildApp({
    authUser: { userId: 'alice-id', role: 'contributor' },
    queryImpl: async (text) => {
      if (text.includes('FROM campaign_members') && text.includes('invite_token')) {
        return {
          rows: [{
            id: 'member-1',
            accepted_at: null,
            email: 'alice@example.com',
            invite_expires_at: new Date(Date.now() + 86400000),
          }],
        };
      }
      if (text.includes('SELECT email FROM users')) {
        return { rows: [{ email: 'alice@example.com' }] };
      }
      if (text.includes('UPDATE campaign_members')) {
        return {
          rows: [{
            id: 'member-1',
            campaign_id: 'camp-1',
            user_id: 'alice-id',
            role: 'manager',
            accepted_at: new Date().toISOString(),
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/members/accept')
    .set('Authorization', 'Bearer token')
    .send({ token: 'validtoken123' });

  assert.equal(response.status, 200);
  assert.equal(response.body.user_id, 'alice-id');
});

test('POST /campaigns/:id/members/accept rejects expired invites (410)', async () => {
  const app = buildApp({
    authUser: { userId: 'alice-id', role: 'contributor' },
    queryImpl: async (text) => {
      if (text.includes('FROM campaign_members') && text.includes('invite_token')) {
        return {
          rows: [{
            id: 'member-1',
            accepted_at: null,
            email: 'alice@example.com',
            invite_expires_at: new Date(Date.now() - 1000), // expired 1 second ago
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/members/accept')
    .set('Authorization', 'Bearer token')
    .send({ token: 'expiredtoken' });

  assert.equal(response.status, 410);
  assert.match(response.body.error, /expired/i);
});

test('POST /campaigns/:id/members/accept rejects already-accepted invite (409)', async () => {
  const app = buildApp({
    authUser: { userId: 'alice-id', role: 'contributor' },
    queryImpl: async (text) => {
      if (text.includes('FROM campaign_members') && text.includes('invite_token')) {
        return {
          rows: [{
            id: 'member-1',
            accepted_at: new Date().toISOString(),
            email: 'alice@example.com',
            invite_expires_at: new Date(Date.now() + 86400000),
          }],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/members/accept')
    .set('Authorization', 'Bearer token')
    .send({ token: 'usedtoken' });

  assert.equal(response.status, 409);
  assert.match(response.body.error, /already accepted/i);
});

test('POST /campaigns/:id/members/accept returns 404 for invalid token', async () => {
  const app = buildApp({
    authUser: { userId: 'alice-id', role: 'contributor' },
    queryImpl: async () => ({ rows: [] }),
  });

  const response = await request(app)
    .post('/api/campaigns/camp-1/members/accept')
    .set('Authorization', 'Bearer token')
    .send({ token: 'nosuchtoken' });

  assert.equal(response.status, 404);
});
