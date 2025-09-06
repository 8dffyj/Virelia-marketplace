// services/expiryManager.js (Updated with Discord status integration)
const { getDB } = require('../config/mongodb');
const SubscriptionService = require('./subscriptionService');

// Import Discord status manager
let discordStatusManager;
try {
  discordStatusManager = require('./discordStatusManager');
} catch (error) {
  console.warn('[WARN] Discord status manager not available:', error.message);
}

const cron = require('node-cron');

class ExpiryManager {
  static init() {
    // Run expiry checks every 6 hours
    cron.schedule('0 */6 * * *', () => {
      this.checkExpiries();
    });

    // Run recovery check on startup with a delay
    setTimeout(() => {
      this.runRecoveryCheck();
    }, 10000); // 10 second delay to ensure DB is ready

    console.log('[INFO] Expiry manager initialized with Discord channel messaging and status updates');
  }

  static async checkExpiries() {
    console.log('[INFO] Running subscription expiry check...');
    
    try {
      await this.sendExpiryWarnings();
      const expiredCount = await this.handleExpiredSubscriptions();
      
      // Update Discord bot status if any subscriptions expired
      if (expiredCount > 0 && discordStatusManager) {
        await discordStatusManager.forceStatusUpdate();
        console.log(`[INFO] Discord bot status updated after ${expiredCount} subscription expiries`);
      }
      
      console.log('[INFO] Expiry check completed successfully');
    } catch (error) {
      console.error('[ERROR] Expiry check failed:', error);
    }
  }

  static async sendExpiryWarnings() {
    const db = getDB();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999); // End of tomorrow
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0); // Start of today

    try {
      // Find active subscriptions expiring within 24 hours that haven't been warned
      const subscriptionsToWarn = await db.collection('subscriptions').find({
        status: 'active',
        expires_at: {
          $gte: todayStart,
          $lte: tomorrow
        },
        warning_sent: { $ne: true }
      }).toArray();

      console.log(`[INFO] Found ${subscriptionsToWarn.length} subscriptions to warn about expiry`);

      let warningsSent = 0;
      for (const subscription of subscriptionsToWarn) {
        try {
          await SubscriptionService.sendExpiryWarningChannelMessage(subscription);
          
          // Mark warning as sent
          await db.collection('subscriptions').updateOne(
            { _id: subscription._id },
            { 
              $set: { 
                warning_sent: true,
                warning_sent_at: new Date(),
                updated_at: new Date()
              }
            }
          );
          
          warningsSent++;
          console.log(`[INFO] Expiry warning sent for subscription ${subscription._id} (user: ${subscription.user_id})`);
          
          // Add small delay between messages to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`[ERROR] Failed to send warning for subscription ${subscription._id}:`, error);
        }
      }
      
      if (warningsSent > 0) {
        console.log(`[INFO] Successfully sent ${warningsSent} expiry warnings`);
      }
      
      return warningsSent;
    } catch (error) {
      console.error('[ERROR] Failed to send expiry warnings:', error);
      return 0;
    }
  }

  static async handleExpiredSubscriptions() {
    const db = getDB();
    const now = new Date();

    try {
      // Find expired active subscriptions
      const expiredSubscriptions = await db.collection('subscriptions').find({
        status: 'active',
        expires_at: { $lt: now }
      }).toArray();

      console.log(`[INFO] Found ${expiredSubscriptions.length} expired subscriptions to process`);

      let processedCount = 0;
      for (const subscription of expiredSubscriptions) {
        try {
          await this.processExpiredSubscription(subscription, db);
          processedCount++;
          
          // Add small delay between processing to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (error) {
          console.error(`[ERROR] Failed to process expired subscription ${subscription._id}:`, error);
        }
      }
      
      if (processedCount > 0) {
        console.log(`[INFO] Successfully processed ${processedCount} expired subscriptions`);
      }
      
      return processedCount;
    } catch (error) {
      console.error('[ERROR] Failed to handle expired subscriptions:', error);
      return 0;
    }
  }

  static async processExpiredSubscription(subscription, db) {
    const now = new Date();
    
    try {
      console.log(`[INFO] Processing expired subscription ${subscription._id} for user ${subscription.user_id}`);
      
      // Remove Discord role if configured
      if (subscription.role_id && process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN) {
        try {
          await SubscriptionService.removeDiscordRole(subscription.user_id, subscription.role_id);
          console.log(`[INFO] Removed Discord role ${subscription.role_id} from user ${subscription.user_id}`);
        } catch (roleError) {
          console.error(`[ERROR] Failed to remove Discord role for user ${subscription.user_id}:`, roleError);
          // Continue processing even if role removal fails
        }
      }

      // Update subscription status to expired
      await db.collection('subscriptions').updateOne(
        { _id: subscription._id },
        { 
          $set: {
            status: 'expired',
            expired_at: now,
            updated_at: now
          }
        }
      );

      // Send expiry notification to Discord channel
      try {
        await SubscriptionService.sendExpiredChannelMessage(subscription);
        console.log(`[INFO] Sent expiry notification for subscription ${subscription._id}`);
      } catch (messageError) {
        console.error(`[ERROR] Failed to send expiry notification for subscription ${subscription._id}:`, messageError);
        // Continue processing even if message sending fails
      }

      console.log(`[INFO] Successfully processed expired subscription ${subscription._id} for user ${subscription.user_id}`);
    } catch (error) {
      console.error(`[ERROR] Failed to process expired subscription ${subscription._id}:`, error);
      throw error;
    }
  }

  static async runRecoveryCheck() {
    console.log('[INFO] Running offline recovery check for stale subscriptions...');
    
    try {
      const db = getDB();
      const now = new Date();
      let statusUpdateNeeded = false;

      // Find subscriptions that expired while the system was offline
      const staleSubscriptions = await db.collection('subscriptions').find({
        status: 'active',
        expires_at: { $lt: now }
      }).toArray();

      if (staleSubscriptions.length > 0) {
        console.log(`[INFO] Found ${staleSubscriptions.length} stale subscriptions from system downtime`);
        
        let recoveryCount = 0;
        for (const subscription of staleSubscriptions) {
          try {
            // Process the expired subscription
            await this.processExpiredSubscription(subscription, db);
            recoveryCount++;
            statusUpdateNeeded = true;
            console.log(`[INFO] Recovery: processed stale subscription ${subscription._id} for user ${subscription.user_id}`);
            
            // Add delay to avoid rate limits during recovery
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            console.error(`[ERROR] Recovery failed for subscription ${subscription._id}:`, error);
          }
        }
        
        console.log(`[INFO] Recovery completed: processed ${recoveryCount}/${staleSubscriptions.length} stale subscriptions`);
      } else {
        console.log('[INFO] No stale subscriptions found during recovery');
      }

      // Also check for any subscriptions that should have warnings but don't
      const now24Hours = new Date(now.getTime() + (24 * 60 * 60 * 1000));
      const missedWarnings = await db.collection('subscriptions').find({
        status: 'active',
        expires_at: { $lt: now24Hours, $gt: now },
        warning_sent: { $ne: true }
      }).toArray();

      if (missedWarnings.length > 0) {
        console.log(`[INFO] Recovery: sending ${missedWarnings.length} missed expiry warnings`);
        let missedWarningCount = 0;
        
        for (const subscription of missedWarnings) {
          try {
            await SubscriptionService.sendExpiryWarningChannelMessage(subscription);
            await db.collection('subscriptions').updateOne(
              { _id: subscription._id },
              { 
                $set: { 
                  warning_sent: true, 
                  warning_sent_at: now,
                  updated_at: now 
                }
              }
            );
            missedWarningCount++;
            
            // Add delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1500));
          } catch (error) {
            console.error(`[ERROR] Recovery warning failed for subscription ${subscription._id}:`, error);
          }
        }
        
        console.log(`[INFO] Recovery: sent ${missedWarningCount}/${missedWarnings.length} missed warnings`);
      }

      // Update Discord bot status if any changes were made during recovery
      if (statusUpdateNeeded && discordStatusManager) {
        await discordStatusManager.forceStatusUpdate();
        console.log(`[INFO] Discord bot status updated after recovery process`);
      }

    } catch (error) {
      console.error('[ERROR] Recovery check failed:', error);
    }
  }

  static async getUserSubscriptionStatus(userId) {
    try {
      return await SubscriptionService.getUserActiveSubscription(userId);
    } catch (error) {
      console.error(`[ERROR] Failed to get subscription status for user ${userId}:`, error);
      return null;
    }
  }

  // Utility method to get all user subscriptions (active and expired)
  static async getUserSubscriptionHistory(userId) {
    const db = getDB();
    
    try {
      const subscriptions = await db.collection('subscriptions').find({
        user_id: userId
      }).sort({ created_at: -1 }).toArray();

      return subscriptions.map(sub => ({
        ...sub,
        duration_text: SubscriptionService.formatDuration(sub.duration_days),
        created_at_ist: SubscriptionService.formatIST(sub.created_at),
        expires_at_ist: SubscriptionService.formatIST(sub.expires_at),
        is_active: sub.status === 'active' && sub.expires_at > new Date()
      }));
    } catch (error) {
      console.error(`[ERROR] Failed to get subscription history for user ${userId}:`, error);
      return [];
    }
  }

  // Admin utility to get subscription stats
  static async getSubscriptionStats() {
    const db = getDB();
    const now = new Date();
    
    try {
      const [activeCount, expiredCount, totalRevenue, recentStats] = await Promise.all([
        db.collection('subscriptions').countDocuments({
          status: 'active',
          expires_at: { $gt: now }
        }),
        db.collection('subscriptions').countDocuments({
          status: 'expired'
        }),
        db.collection('transactions').aggregate([
          { $match: { type: 'subscription_purchase', status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$final_price_vv' } } }
        ]).toArray(),
        db.collection('subscriptions').aggregate([
          {
            $match: {
              created_at: { $gte: new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000)) } // Last 30 days
            }
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } },
              count: { $sum: 1 },
              revenue: { $sum: '$paid_price_vv' }
            }
          },
          { $sort: { _id: -1 } },
          { $limit: 30 }
        ]).toArray()
      ]);

      return {
        active_subscriptions: activeCount,
        expired_subscriptions: expiredCount,
        total_revenue_vv: totalRevenue[0]?.total || 0,
        recent_activity: recentStats,
        last_updated: now,
        checks: {
          last_expiry_check: this.lastExpiryCheck,
          next_scheduled_check: this.getNextScheduledCheck()
        },
        discord_status: discordStatusManager ? await discordStatusManager.healthCheck() : null
      };
    } catch (error) {
      console.error('[ERROR] Failed to get subscription stats:', error);
      return {
        error: 'Failed to retrieve statistics',
        last_updated: now
      };
    }
  }

  // Get next scheduled expiry check time
  static getNextScheduledCheck() {
    const now = new Date();
    const nextCheck = new Date(now);
    
    // Next check is at the next 6-hour mark (00:00, 06:00, 12:00, 18:00)
    const currentHour = now.getHours();
    const nextCheckHour = Math.ceil((currentHour + 1) / 6) * 6;
    
    if (nextCheckHour >= 24) {
      nextCheck.setDate(nextCheck.getDate() + 1);
      nextCheck.setHours(0, 0, 0, 0);
    } else {
      nextCheck.setHours(nextCheckHour, 0, 0, 0);
    }
    
    return nextCheck;
  }

  // Manual trigger for expiry check (for admin use)
  static async forceExpiryCheck() {
    console.log('[INFO] Manual expiry check triggered');
    this.lastExpiryCheck = new Date();
    await this.checkExpiries();
    return {
      success: true,
      checked_at: this.lastExpiryCheck,
      message: 'Expiry check completed'
    };
  }

  // Get users with subscriptions expiring soon (for admin dashboard)
  static async getUpcomingExpiries(days = 7) {
    const db = getDB();
    const now = new Date();
    const futureDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    try {
      const upcomingExpiries = await db.collection('subscriptions').aggregate([
        {
          $match: {
            status: 'active',
            expires_at: {
              $gt: now,
              $lte: futureDate
            }
          }
        },
        {
          $lookup: {
            from: 'users',
            localField: 'user_id',
            foreignField: '_id',
            as: 'user'
          }
        },
        {
          $unwind: '$user'
        },
        {
          $sort: { expires_at: 1 }
        }
      ]).toArray();

      return upcomingExpiries.map(sub => ({
        subscription_id: sub._id,
        user_id: sub.user_id,
        username: sub.user?.discord?.username || sub.user?.username,
        plan_title: sub.title,
        expires_at: sub.expires_at,
        expires_in_days: Math.ceil((sub.expires_at - now) / (24 * 60 * 60 * 1000)),
        warning_sent: sub.warning_sent || false
      }));
    } catch (error) {
      console.error('[ERROR] Failed to get upcoming expiries:', error);
      return [];
    }
  }

  // Health check method
  static async healthCheck() {
    try {
      const db = getDB();
      const now = new Date();
      
      // Check database connectivity
      await db.collection('subscriptions').findOne({}, { limit: 1 });
      
      // Check Discord API connectivity if configured
      let discordStatus = 'not_configured';
      if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID) {
        try {
          await SubscriptionService.getGuildInfo();
          discordStatus = 'connected';
        } catch (error) {
          discordStatus = 'error';
        }
      }

      // Check Discord status manager
      let statusManagerHealth = null;
      if (discordStatusManager) {
        statusManagerHealth = await discordStatusManager.healthCheck();
      }
      
      return {
        status: 'healthy',
        timestamp: now,
        database: 'connected',
        discord: discordStatus,
        discord_status_manager: statusManagerHealth,
        next_check: this.getNextScheduledCheck(),
        uptime: process.uptime()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date(),
        error: error.message,
        uptime: process.uptime()
      };
    }
  }

  // Force update Discord status (for admin use)
  static async forceDiscordStatusUpdate() {
    if (!discordStatusManager) {
      throw new Error('Discord status manager not available');
    }

    try {
      await discordStatusManager.forceStatusUpdate();
      return {
        success: true,
        message: 'Discord status updated successfully',
        timestamp: new Date()
      };
    } catch (error) {
      console.error('[ERROR] Failed to force Discord status update:', error);
      throw error;
    }
  }

  // Get current Discord status info
  static getDiscordStatusInfo() {
    if (!discordStatusManager) {
      return {
        available: false,
        message: 'Discord status manager not initialized'
      };
    }

    return {
      available: true,
      info: discordStatusManager.getStatusInfo(),
      last_updated: this.lastStatusUpdate
    };
  }
}

// Track last expiry check and status update times
ExpiryManager.lastExpiryCheck = null;
ExpiryManager.lastStatusUpdate = null;

module.exports = ExpiryManager;