// migration/migrateSubscriptions.js
// Run this script once to migrate from old structure to new subscriptions table
const { MongoClient } = require('mongodb');
require('dotenv').config();

async function migrateSubscriptions() {
  let client;
  
  try {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.MONGODB_NAME || 'virelia');
    
    console.log('Starting subscription migration...');
    
    // Find all users with the old subscription structure
    const usersWithOldSubs = await db.collection('users').find({
      'subscription.plan_id': { $exists: true }
    }).toArray();
    
    console.log(`Found ${usersWithOldSubs.length} users with old subscription structure`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const user of usersWithOldSubs) {
      try {
        const oldSub = user.subscription;
        const now = new Date();
        const isActive = new Date(oldSub.expires_at) > now;
        
        // Check if this subscription was already migrated
        const existingNewSub = await db.collection('subscriptions').findOne({
          user_id: user._id,
          plan_id: oldSub.plan_id,
          created_at: { $gte: new Date(oldSub.started_at || oldSub.created_at || now) }
        });
        
        if (existingNewSub) {
          console.log(`Skipping user ${user._id} - already migrated`);
          skippedCount++;
          continue;
        }
        
        // Create new subscription record
        const newSubscription = {
          user_id: user._id,
          plan_id: oldSub.plan_id,
          title: oldSub.title || 'Migrated Subscription',
          role_id: oldSub.role_id,
          status: isActive ? 'active' : 'expired',
          created_at: new Date(oldSub.started_at || oldSub.created_at || now),
          started_at: new Date(oldSub.started_at || oldSub.created_at || now),
          expires_at: new Date(oldSub.expires_at),
          duration_days: oldSub.total_days || 30,
          original_price_vv: 0, // Unknown from old structure
          paid_price_vv: 0,     // Unknown from old structure
          discount_applied: null,
          is_renewal: false,
          warning_sent: oldSub.warning_sent || false,
          source: 'migration_v1'
        };
        
        // Add expired_at if subscription is expired
        if (!isActive) {
          newSubscription.expired_at = newSubscription.expires_at;
        }
        
        await db.collection('subscriptions').insertOne(newSubscription);
        
        // Remove old subscription structure from user
        await db.collection('users').updateOne(
          { _id: user._id },
          { $unset: { subscription: "" } }
        );
        
        console.log(`Migrated subscription for user ${user._id} (${user.username})`);
        migratedCount++;
        
      } catch (error) {
        console.error(`Failed to migrate subscription for user ${user._id}:`, error);
      }
    }
    
    // Initialize VV balance for users who don't have it
    const usersWithoutBalance = await db.collection('users').find({
      vv_balance: { $exists: false }
    }).toArray();
    
    console.log(`\nInitializing VV balance for ${usersWithoutBalance.length} users...`);
    
    const defaultBalance = parseInt(process.env.DEFAULT_VV_BALANCE) || 500;
    let balanceInitCount = 0;
    
    for (const user of usersWithoutBalance) {
      try {
        await db.collection('users').updateOne(
          { _id: user._id },
          { 
            $set: { 
              vv_balance: defaultBalance,
              updated_at: new Date()
            }
          }
        );
        balanceInitCount++;
      } catch (error) {
        console.error(`Failed to initialize balance for user ${user._id}:`, error);
      }
    }
    
    console.log('\n=== Migration Summary ===');
    console.log(`Subscriptions migrated: ${migratedCount}`);
    console.log(`Subscriptions skipped: ${skippedCount}`);
    console.log(`VV balances initialized: ${balanceInitCount}`);
    console.log('Migration completed successfully!');
    
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrateSubscriptions()
    .then(() => {
      console.log('Migration script completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = migrateSubscriptions;