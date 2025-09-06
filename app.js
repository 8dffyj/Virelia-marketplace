// app.js (Updated with Discord status integration)
const express = require("express");
const session = require("express-session");
const passport = require("./config/passport");
const path = require("path");
const { connectMongoDB, getDB, closeMongoDB } = require("./config/mongodb");
const ExpiryManager = require("./services/expiryManager");
const discordStatusManager = require("./services/discordStatusManager");
const { initDiscordLogger } = require("./utils/discordLogger");
require("dotenv").config();

const app = express();

// Initialize Discord logger if webhook URL is provided
const discordLogger = initDiscordLogger(process.env.DISCORD_LOG_WEBHOOK_URL, {
  batchSize: 8,
  batchInterval: 8000 // 8 seconds
});

if (discordLogger) {
  discordLogger.init();
}

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || "super-secret-key-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Make user available in views with proper error handling
app.use(async (req, res, next) => {
  res.locals.user = req.user;
  
  // If user is authenticated, get their MongoDB data
  if (req.user && req.user._id) {
    try {
      const db = getDB();
      const userData = await db.collection('users').findOne({ _id: req.user._id });
      if (userData) {
        // Ensure user has VV balance
        if (userData.vv_balance === undefined || userData.vv_balance === null) {
          const defaultBalance = parseInt(process.env.DEFAULT_VV_BALANCE) || 500;
          await db.collection('users').updateOne(
            { _id: userData._id },
            { $set: { vv_balance: defaultBalance, updated_at: new Date() } }
          );
          userData.vv_balance = defaultBalance;
          console.log(`[INFO] Initialized balance for user ${userData._id}: ${defaultBalance} VV`);
        }
        
        res.locals.user = userData;
        req.user = userData; // Update req.user with full data
      } else {
        console.warn(`[WARN] Authenticated user ${req.user._id} not found in database`);
        // Don't log them out, let them proceed - passport will handle re-auth if needed
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
      // Don't fail the request, just log the error
    }
  }
  
  next();
});

// Routes
app.use("/auth", require("./routes/auth"));
app.use("/", require("./routes/subscription"));

// Basic routes
app.get("/", (req, res) => {
  res.render("home", {
    user: req.user
  });
});

// Health check endpoint (enhanced with Discord status info)
app.get("/health", async (req, res) => {
  try {
    const statusInfo = await discordStatusManager.healthCheck();
    
    res.json({
      status: "OK",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      discord_status: statusInfo,
      services: {
        database: 'connected',
        discord_status_updater: statusInfo.updater_running ? 'running' : 'stopped',
        expiry_manager: 'running'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Admin endpoint to manually update Discord status
app.get("/admin/update-status", async (req, res) => {
  // Simple admin check
  if (!process.env.ADMIN_USER_IDS || !req.user || !process.env.ADMIN_USER_IDS.split(',').includes(req.user._id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    await discordStatusManager.forceStatusUpdate();
    const statusInfo = await discordStatusManager.healthCheck();
    
    res.json({
      success: true,
      message: 'Discord status updated successfully',
      current_status: statusInfo
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to update Discord status',
      details: error.message
    });
  }
});

// Admin endpoint for Discord status info
app.get("/admin/discord-status", async (req, res) => {
  // Simple admin check
  if (!process.env.ADMIN_USER_IDS || !req.user || !process.env.ADMIN_USER_IDS.split(',').includes(req.user._id)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const statusInfo = await discordStatusManager.healthCheck();
    const managerInfo = discordStatusManager.getStatusInfo();
    
    res.json({
      discord_status: statusInfo,
      manager_info: managerInfo,
      environment: {
        bot_token_configured: !!process.env.DISCORD_BOT_TOKEN,
        guild_id_configured: !!process.env.DISCORD_GUILD_ID,
        purchase_channel_configured: !!process.env.DISCORD_PURCHASE_CHANNEL_ID,
        expiry_channel_configured: !!process.env.DISCORD_EXPIRY_CHANNEL_ID
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get Discord status info',
      details: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).render("404", { 
    title: "Page Not Found",
    message: "The page you're looking for doesn't exist." 
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Application error:', error);
  
  // Don't show stack traces in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  // Check if it's a database connection error
  if (error.name === 'MongoError' || error.name === 'MongoNetworkError') {
    console.error('[CRITICAL] Database connection error:', error.message);
    return res.status(503).render("error", {
      title: "Service Unavailable",
      message: "Database connection error. Please try again later.",
      error: isDevelopment ? error : {}
    });
  }
  
  // Check if headers were already sent
  if (res.headersSent) {
    return next(error);
  }
  
  res.status(error.status || 500).render("error", {
    title: "Server Error",
    message: error.message || "Something went wrong on our end.",
    error: isDevelopment ? error : {}
  });
});

// Initialize application
async function startServer() {
  try {
    // Connect to MongoDB
    await connectMongoDB();
    console.log('[INFO] MongoDB connected successfully');
    
    // Initialize expiry manager for subscription handling
    ExpiryManager.init();
    console.log('[INFO] Subscription expiry manager initialized');
    
    // Initialize Discord status manager
    discordStatusManager.init();
    console.log('[INFO] Discord status manager initialized');
    
    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
      console.log(`[INFO] Server running on http://localhost:${PORT}`);
      console.log(`[INFO] Environment: ${process.env.NODE_ENV || 'development'}`);
      
      // Log available routes
      console.log('[INFO] Available routes:');
      console.log('  GET  / - Home page');
      console.log('  GET  /profile - User profile with subscription info');
      console.log('  GET  /minecraft/subscription - Subscription catalog');
      console.log('  POST /minecraft/subscription/purchase - Purchase subscription');
      console.log('  GET  /auth/discord - Discord OAuth login');
      console.log('  GET  /auth/discord/callback - Discord OAuth callback');
      console.log('  GET  /auth/logout - Logout');
      console.log('  GET  /health - Health check');
      console.log('  GET  /admin/update-status - Force Discord status update (admin only)');
      console.log('  GET  /admin/discord-status - Discord status info (admin only)');
      
      // Log configuration status
      const configStatus = {
        mongodb: !!process.env.MONGODB_URI,
        discord_oauth: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
        discord_bot: !!process.env.DISCORD_BOT_TOKEN,
        discord_guild: !!process.env.DISCORD_GUILD_ID,
        discord_channels: !!(process.env.DISCORD_PURCHASE_CHANNEL_ID && process.env.DISCORD_EXPIRY_CHANNEL_ID),
        discord_status_updates: !!process.env.DISCORD_BOT_TOKEN,
        default_balance: process.env.DEFAULT_VV_BALANCE || '500'
      };
      
      console.log('[INFO] Configuration status:', configStatus);
      
      if (configStatus.discord_status_updates) {
        console.log('[INFO] Discord bot status updates enabled - will show active subscription count');
      } else {
        console.log('[WARN] Discord bot status updates disabled - DISCORD_BOT_TOKEN not configured');
      }
    });

    return server;
  } catch (error) {
    console.error('[ERROR] Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`[INFO] Received ${signal}, shutting down gracefully...`);
  
  try {
    // Stop Discord status updater
    discordStatusManager.stop();
    console.log('[INFO] Discord status updater stopped');
    
    // Close MongoDB connection
    await closeMongoDB();
    console.log('[INFO] Database connections closed');
    
    // Restore Discord logger if needed
    if (discordLogger) {
      discordLogger.restore();
    }
    
    console.log('[INFO] Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('[ERROR] Error during graceful shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[ERROR] Uncaught Exception:', error);
  
  // Try to close connections gracefully
  discordStatusManager.stop();
  closeMongoDB().finally(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
  
  // Try to close connections gracefully
  discordStatusManager.stop();
  closeMongoDB().finally(() => {
    process.exit(1);
  });
});

// Start the server
startServer().catch(error => {
  console.error('[ERROR] Failed to start application:', error);
  process.exit(1);
});