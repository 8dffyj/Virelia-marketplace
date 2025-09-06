// routes/subscription.js (Updated with proper decimal balance handling)
const router = require('express').Router();
const { getDB } = require('../config/mongodb');
const SubscriptionService = require('../services/subscriptionService');
const crypto = require('crypto');

// Middleware to ensure user is authenticated
const requireAuth = (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/');
  }
  next();
};

// GET /minecraft/subscription - Display subscription catalog with decimal support
router.get('/minecraft/subscription', requireAuth, async (req, res) => {
  try {
    const plans = await SubscriptionService.getPlans();
    const plansWithPrices = plans.map(plan => {
      const priceInfo = SubscriptionService.calculateFinalPrice(plan, true);
      return {
        ...plan,
        final_price: priceInfo.finalPrice,
        discount_amount: priceInfo.discountAmount,
        duration_text: SubscriptionService.formatDuration(plan.days),
        formatted_final_price: priceInfo.formattedFinal,
        formatted_original_price: priceInfo.formattedOriginal,
        formatted_discount: priceInfo.formattedDiscount
      };
    });

    const db = getDB();
    // Ensure we get the most up-to-date user data with balance
    const user = await db.collection('users').findOne({ _id: req.user._id || req.user.id });
    
    if (!user) {
      console.error(`[ERROR] User not found in database: ${req.user._id || req.user.id}`);
      return res.status(404).send('User not found');
    }

    // Ensure user has a balance field (handle as decimal)
    let userBalance = parseFloat(user.vv_balance || 0);
    if (user.vv_balance === undefined || user.vv_balance === null) {
      // Initialize balance if it doesn't exist (use decimal default)
      const defaultBalance = parseFloat(process.env.DEFAULT_VV_BALANCE) || 500.0;
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { vv_balance: defaultBalance, updated_at: new Date() } }
      );
      userBalance = defaultBalance;
      console.log(`[INFO] Initialized balance for user ${user._id}: ${SubscriptionService.formatVV(defaultBalance)} VV`);
    }

    console.log(`[DEBUG] User ${user._id} balance: ${SubscriptionService.formatVV(userBalance)} VV`);
    
    res.render('subscription', {
      plans: plansWithPrices,
      user: { ...user, vv_balance: userBalance },
      userBalance: userBalance
    });
  } catch (error) {
    console.error('[ERROR] Failed to load subscription page:', error);
    res.status(500).render('error', {
      title: 'Error Loading Subscriptions',
      message: 'Failed to load subscription plans. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST /minecraft/subscription/purchase - Purchase a subscription with decimal support
router.post('/minecraft/subscription/purchase', requireAuth, async (req, res) => {
  try {
    const { plan_id } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || crypto.randomUUID();
    
    if (!plan_id) {
      return res.status(400).json({ error: 'Plan ID is required' });
    }

    console.log(`[INFO] Processing subscription purchase: User ${req.user._id || req.user.id}, Plan ${plan_id}`);

    const result = await SubscriptionService.purchaseSubscription(
      req.user._id || req.user.id,
      plan_id,
      idempotencyKey
    );

    res.json({
      success: true,
      message: 'Subscription purchased successfully! You will receive your Discord role shortly.',
      final_price: result.finalPrice,
      formatted_final_price: SubscriptionService.formatVV(result.finalPrice),
      subscription_id: result.subscription._id,
      expires_at: result.subscription.expires_at,
      is_renewal: result.isRenewal || false
    });
  } catch (error) {
    console.error('[ERROR] Subscription purchase failed:', error);
    
    // Return appropriate error message
    let errorMessage = 'Purchase failed';
    if (error.message.includes('Insufficient VV balance')) {
      errorMessage = error.message;
    } else if (error.message.includes('Plan not found')) {
      errorMessage = 'Selected plan is not available';
    } else if (error.message.includes('already processed')) {
      errorMessage = 'Transaction already processed';
    } else if (error.message.includes('User not found')) {
      errorMessage = 'User account not found';
    }
    
    res.status(400).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /profile - Enhanced profile with subscription info and decimal support
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const db = getDB();
    const user = await db.collection('users').findOne({ _id: req.user._id || req.user.id });
    
    if (!user) {
      console.error(`[ERROR] User not found: ${req.user._id || req.user.id}`);
      return res.status(404).render('error', {
        title: 'User Not Found',
        message: 'Your user account could not be found.'
      });
    }

    // Ensure user has balance (handle as decimal)
    let userBalance = parseFloat(user.vv_balance || 0);
    if (user.vv_balance === undefined || user.vv_balance === null) {
      const defaultBalance = parseFloat(process.env.DEFAULT_VV_BALANCE) || 500.0;
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { vv_balance: defaultBalance, updated_at: new Date() } }
      );
      userBalance = defaultBalance;
      user.vv_balance = userBalance;
    }

    // Get active subscription using the service
    const subscriptionInfo = await SubscriptionService.getUserActiveSubscription(user._id);
    
    res.render('profile', {
      user: { ...user, vv_balance: userBalance },
      subscription: subscriptionInfo
    });
  } catch (error) {
    console.error('[ERROR] Failed to load profile:', error);
    res.render('profile', { 
      user: req.user, 
      subscription: null,
      error: 'Failed to load subscription information'
    });
  }
});

// GET /admin/subscriptions - Admin panel for subscription management with decimal support
router.get('/admin/subscriptions', requireAuth, async (req, res) => {
  // Simple admin check
  if (!process.env.ADMIN_USER_IDS || !process.env.ADMIN_USER_IDS.split(',').includes(req.user._id || req.user.id)) {
    return res.status(403).send('Access denied');
  }

  try {
    const db = getDB();
    const [activeSubscriptions, recentTransactions, stats] = await Promise.all([
      db.collection('subscriptions').find({ status: 'active' })
        .sort({ expires_at: 1 })
        .limit(20)
        .toArray(),
      db.collection('transactions').find({ type: 'subscription_purchase' })
        .sort({ created_at: -1 })
        .limit(20)
        .toArray(),
      db.collection('subscriptions').aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            total_revenue: { $sum: '$paid_price_vv' }
          }
        }
      ]).toArray()
    ]);

    // Format decimal values in the response
    const formattedStats = stats.map(stat => ({
      ...stat,
      total_revenue: parseFloat(stat.total_revenue || 0),
      formatted_revenue: SubscriptionService.formatVV(stat.total_revenue || 0)
    }));

    const formattedTransactions = recentTransactions.map(tx => ({
      ...tx,
      final_price_vv: parseFloat(tx.final_price_vv || 0),
      formatted_final_price: SubscriptionService.formatVV(tx.final_price_vv || 0),
      user_balance_before: parseFloat(tx.user_balance_before || 0),
      user_balance_after: parseFloat(tx.user_balance_after || 0),
      formatted_balance_before: SubscriptionService.formatVV(tx.user_balance_before || 0),
      formatted_balance_after: SubscriptionService.formatVV(tx.user_balance_after || 0)
    }));

    const formattedSubscriptions = activeSubscriptions.map(sub => ({
      ...sub,
      paid_price_vv: parseFloat(sub.paid_price_vv || 0),
      total_paid_vv: parseFloat(sub.total_paid_vv || 0),
      formatted_paid_price: SubscriptionService.formatVV(sub.paid_price_vv || 0),
      formatted_total_paid: SubscriptionService.formatVV(sub.total_paid_vv || 0)
    }));

    res.json({
      active_subscriptions: formattedSubscriptions,
      recent_transactions: formattedTransactions,
      stats: formattedStats,
      summary: {
        total_active: formattedSubscriptions.length,
        total_revenue_all: formattedStats.reduce((sum, stat) => sum + stat.total_revenue, 0),
        formatted_total_revenue: SubscriptionService.formatVV(
          formattedStats.reduce((sum, stat) => sum + stat.total_revenue, 0)
        )
      }
    });
  } catch (error) {
    console.error('[ERROR] Admin panel failed:', error);
    res.status(500).json({ error: 'Failed to load admin data' });
  }
});

// GET /admin/users - Admin endpoint to view user balances
router.get('/admin/users', requireAuth, async (req, res) => {
  // Simple admin check
  if (!process.env.ADMIN_USER_IDS || !process.env.ADMIN_USER_IDS.split(',').includes(req.user._id || req.user.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const db = getDB();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const users = await db.collection('users')
      .find({})
      .sort({ vv_balance: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalUsers = await db.collection('users').countDocuments({});

    const formattedUsers = users.map(user => ({
      _id: user._id,
      username: user.username,
      email: user.email,
      vv_balance: parseFloat(user.vv_balance || 0),
      formatted_balance: SubscriptionService.formatVV(user.vv_balance || 0),
      last_login: user.last_login,
      created_at: user.created_at
    }));

    res.json({
      users: formattedUsers,
      pagination: {
        current_page: page,
        total_pages: Math.ceil(totalUsers / limit),
        total_users: totalUsers,
        per_page: limit
      },
      summary: {
        total_balance: formattedUsers.reduce((sum, user) => sum + user.vv_balance, 0),
        formatted_total_balance: SubscriptionService.formatVV(
          formattedUsers.reduce((sum, user) => sum + user.vv_balance, 0)
        ),
        average_balance: formattedUsers.length > 0 
          ? formattedUsers.reduce((sum, user) => sum + user.vv_balance, 0) / formattedUsers.length 
          : 0
      }
    });
  } catch (error) {
    console.error('[ERROR] Admin users endpoint failed:', error);
    res.status(500).json({ error: 'Failed to load user data' });
  }
});

// POST /admin/users/:userId/balance - Admin endpoint to adjust user balance
router.post('/admin/users/:userId/balance', requireAuth, async (req, res) => {
  // Simple admin check
  if (!process.env.ADMIN_USER_IDS || !process.env.ADMIN_USER_IDS.split(',').includes(req.user._id || req.user.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const { userId } = req.params;
    const { amount, operation, reason } = req.body; // operation: 'set', 'add', 'subtract'
    
    if (!amount || !operation) {
      return res.status(400).json({ error: 'Amount and operation are required' });
    }

    const adjustmentAmount = parseFloat(amount);
    if (isNaN(adjustmentAmount)) {
      return res.status(400).json({ error: 'Invalid amount format' });
    }

    const db = getDB();
    const user = await db.collection('users').findOne({ _id: userId });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentBalance = parseFloat(user.vv_balance || 0);
    let newBalance;

    switch (operation) {
      case 'set':
        newBalance = adjustmentAmount;
        break;
      case 'add':
        newBalance = currentBalance + adjustmentAmount;
        break;
      case 'subtract':
        newBalance = Math.max(0, currentBalance - adjustmentAmount);
        break;
      default:
        return res.status(400).json({ error: 'Invalid operation. Use: set, add, or subtract' });
    }

    // Update user balance
    await db.collection('users').updateOne(
      { _id: userId },
      { 
        $set: { 
          vv_balance: newBalance, 
          updated_at: new Date() 
        } 
      }
    );

    // Log the admin action
    await db.collection('admin_actions').insertOne({
      admin_user_id: req.user._id || req.user.id,
      target_user_id: userId,
      action_type: 'balance_adjustment',
      operation: operation,
      amount: adjustmentAmount,
      balance_before: currentBalance,
      balance_after: newBalance,
      reason: reason || 'No reason provided',
      created_at: new Date()
    });

    console.log(`[INFO] Admin ${req.user._id} adjusted balance for user ${userId}: ${SubscriptionService.formatVV(currentBalance)} -> ${SubscriptionService.formatVV(newBalance)} VV (${operation}: ${SubscriptionService.formatVV(adjustmentAmount)})`);

    res.json({
      success: true,
      message: `Balance ${operation} completed successfully`,
      balance_before: currentBalance,
      balance_after: newBalance,
      formatted_balance_before: SubscriptionService.formatVV(currentBalance),
      formatted_balance_after: SubscriptionService.formatVV(newBalance),
      adjustment_amount: adjustmentAmount,
      formatted_adjustment: SubscriptionService.formatVV(adjustmentAmount)
    });
  } catch (error) {
    console.error('[ERROR] Admin balance adjustment failed:', error);
    res.status(500).json({ error: 'Failed to adjust user balance' });
  }
});

module.exports = router;