const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const {
  getAccountMultisigConfig,
  getWalletTransactionHistory,
  getWalletPayments,
  recoverWalletFromSecret,
} = require('../services/stellarService');
const { decryptSecret } = require('../services/walletService');

// Get wallet configuration (signers, thresholds)
router.get('/:campaignId/config', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (rows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const config = await getAccountMultisigConfig(rows[0].wallet_public_key);
  res.json(config);
});

// Get wallet transaction history
router.get('/:campaignId/transactions', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (rows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const limit = parseInt(req.query.limit) || 50;
  const txs = await getWalletTransactionHistory(rows[0].wallet_public_key, limit);
  res.json(txs);
});

// Get wallet payment history (audit trail)
router.get('/:campaignId/payments', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (rows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const limit = parseInt(req.query.limit) || 100;
  const payments = await getWalletPayments(rows[0].wallet_public_key, limit);
  res.json(payments);
});

// Recover wallet keypair (creator only - requires encrypted secret)
router.post('/:campaignId/recover', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT wallet_secret_encrypted, wallet_public_key, creator_id FROM campaigns WHERE id = $1',
    [req.params.campaignId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (rows[0].creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!rows[0].wallet_secret_encrypted) {
    return res.status(400).json({ error: 'No encrypted secret stored for this campaign' });
  }

  try {
    const secret = decryptSecret(rows[0].wallet_secret_encrypted);
    const wallet = await recoverWalletFromSecret(secret);
    if (wallet.publicKey !== rows[0].wallet_public_key) {
      return res.status(500).json({
        error: 'Stored secret does not match the campaign wallet public key',
      });
    }
    res.json({ publicKey: wallet.publicKey, verified: true });
  } catch {
    return res.status(500).json({ error: 'Could not recover campaign wallet keypair' });
  }
});

module.exports = router;
