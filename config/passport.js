// config/passport.js (Updated with proper decimal balance initialization)
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const { getDB } = require("./mongodb");
const axios = require("axios");
require("dotenv").config();

passport.serializeUser((user, done) => done(null, user._id));

passport.deserializeUser(async (id, done) => {
  try {
    const db = getDB();
    const user = await db.collection('users').findOne({ _id: id });
    if (!user) {
      console.error(`[ERROR] User not found during deserialization: ${id}`);
      return done(null, false);
    }
    done(null, user);
  } catch (error) {
    console.error('[ERROR] Failed to deserialize user:', error);
    done(error, null);
  }
});

passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_REDIRECT_URI,
  scope: ["identify", "email", "guilds.join"]
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const db = getDB();
    const existingUser = await db.collection('users').findOne({ _id: profile.id });

    // Parse default balance as decimal (supports both integer and decimal values)
    const defaultBalance = parseFloat(process.env.DEFAULT_VV_BALANCE) || 500.0;
    const now = new Date();

    let userData = {
      _id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      email: profile.email,
      discord: {
        id: profile.id,
        username: profile.username,
        display_name: profile.displayName || profile.username,
        avatar: `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`,
        email: profile.email
      },
      last_login: now,
      updated_at: now
    };

    if (!existingUser) {
      // New user - create with default VV balance (decimal support)
      userData.vv_balance = defaultBalance;
      userData.created_at = now;
      
      await db.collection('users').insertOne(userData);
      
      // Format balance for logging
      const formattedBalance = defaultBalance < 1 && defaultBalance > 0 
        ? defaultBalance.toFixed(8).replace(/\.?0+$/, '')
        : defaultBalance >= 1000 
          ? defaultBalance.toLocaleString('en-US', { maximumFractionDigits: 8 })
          : defaultBalance.toFixed(6).replace(/\.?0+$/, '');
          
      console.log(`[INFO] New user created: ${profile.username} (${profile.id}) with ${formattedBalance} VV balance`);
    } else {
      // Existing user - update their information
      const updateData = {
        username: profile.username,
        avatar: profile.avatar,
        email: profile.email,
        discord: userData.discord,
        last_login: now,
        updated_at: now
      };
      
      // Initialize VV balance if it doesn't exist (decimal support)
      if (existingUser.vv_balance === undefined || existingUser.vv_balance === null) {
        updateData.vv_balance = defaultBalance;
        
        const formattedBalance = defaultBalance < 1 && defaultBalance > 0 
          ? defaultBalance.toFixed(8).replace(/\.?0+$/, '')
          : defaultBalance >= 1000 
            ? defaultBalance.toLocaleString('en-US', { maximumFractionDigits: 8 })
            : defaultBalance.toFixed(6).replace(/\.?0+$/, '');
            
        console.log(`[INFO] Initialized VV balance for existing user ${profile.id}: ${formattedBalance} VV`);
      } else {
        // Ensure existing balance is stored as a proper number
        const currentBalance = parseFloat(existingUser.vv_balance);
        if (!isNaN(currentBalance)) {
          updateData.vv_balance = currentBalance;
        }
      }
      
      await db.collection('users').updateOne(
        { _id: profile.id },
        { $set: updateData }
      );
      
      console.log(`[INFO] User updated: ${profile.username} (${profile.id})`);
      
      // Merge updated data with existing user data
      userData = { ...existingUser, ...updateData };
    }

    // Auto-join Discord guild if configured
    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN) {
      try {
        await axios.put(
          `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${profile.id}`,
          { access_token: accessToken },
          { 
            headers: { 
              Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            } 
          }
        );
        console.log(`[INFO] User ${profile.username} auto-joined Discord guild`);
      } catch (guildError) {
        // Don't fail authentication if guild join fails
        console.warn(`[WARN] Failed to auto-join user ${profile.id} to guild:`, 
          guildError.response?.data || guildError.message);
      }
    }

    // Return user with consistent structure and proper decimal balance
    return done(null, {
      _id: profile.id,
      ...userData,
      // Ensure vv_balance is always a number
      vv_balance: parseFloat(userData.vv_balance || defaultBalance)
    });
  } catch (error) {
    console.error('[ERROR] Discord authentication failed:', error);
    return done(error, null);
  }
}));

module.exports = passport;