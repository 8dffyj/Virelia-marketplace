// services/discordStatusManager.js - Discord Bot Status Management (Event-driven with persistent connection)
const { getDB } = require('../config/mongodb');
const WebSocket = require('ws');
const axios = require('axios');

class DiscordStatusManager {
  constructor() {
    this.ws = null;
    this.heartbeatInterval = null;
    this.lastSequence = null;
    this.sessionId = null;
    this.lastCount = null;
    this.isUpdating = false;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.gatewayUrl = null;
  }

  // Initialize Discord bot connection
  async init() {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.warn('[WARN] Discord bot status updates disabled - DISCORD_BOT_TOKEN not set');
      return;
    }

    try {
      await this.connect();
      console.log('[INFO] Discord bot status manager initialized');
    } catch (error) {
      console.error('[ERROR] Failed to initialize Discord status manager:', error);
    }
  }

  // Connect to Discord Gateway
  async connect() {
    try {
      if (!this.gatewayUrl) {
        const response = await axios.get('https://discord.com/api/gateway/bot', {
          headers: {
            'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });
        this.gatewayUrl = response.data.url;
      }

      this.ws = new WebSocket(`${this.gatewayUrl}/?v=10&encoding=json`);
      this.setupWebSocketHandlers();

    } catch (error) {
      console.error('[ERROR] Failed to connect to Discord Gateway:', error);
      this.scheduleReconnect();
    }
  }

  // Setup WebSocket event handlers
  setupWebSocketHandlers() {
    this.ws.on('open', () => {
      console.log('[INFO] Discord Gateway connection established');
      this.isConnected = true;
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data) => {
      this.handleMessage(JSON.parse(data));
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[WARN] Discord Gateway connection closed: ${code} ${reason}`);
      this.isConnected = false;
      this.cleanup();
      
      if (code !== 1000) { // Not normal closure
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      console.error('[ERROR] Discord Gateway WebSocket error:', error);
      this.isConnected = false;
    });
  }

  // Handle incoming WebSocket messages
  handleMessage(payload) {
    const { op, d, s, t } = payload;

    if (s) {
      this.lastSequence = s;
    }

    switch (op) {
      case 10: // Hello
        this.startHeartbeat(d.heartbeat_interval);
        this.identify();
        break;

      case 0: // Dispatch
        this.handleDispatch(t, d);
        break;

      case 1: // Heartbeat
        this.sendHeartbeat();
        break;

      case 7: // Reconnect
        console.log('[INFO] Discord requested reconnection');
        this.reconnect();
        break;

      case 9: // Invalid Session
        console.log('[WARN] Invalid session, reconnecting...');
        this.sessionId = null;
        this.lastSequence = null;
        setTimeout(() => this.identify(), 5000);
        break;

      case 11: // Heartbeat ACK
        // Heartbeat acknowledged
        break;

      default:
        // Ignore other opcodes
        break;
    }
  }

  // Handle dispatch events
  handleDispatch(type, data) {
    switch (type) {
      case 'READY':
        console.log('[INFO] Discord bot ready, updating status...');
        this.sessionId = data.session_id;
        this.updateStatus();
        break;

      case 'RESUMED':
        console.log('[INFO] Discord connection resumed');
        break;

      default:
        // Ignore other events
        break;
    }
  }

  // Start heartbeat interval
  startHeartbeat(interval) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }

  // Send heartbeat
  sendHeartbeat() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 1,
        d: this.lastSequence
      }));
    }
  }

  // Send identify payload
  identify() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 2,
        d: {
          token: process.env.DISCORD_BOT_TOKEN,
          intents: 0, // Minimal intents
          properties: {
            $os: 'linux',
            $browser: 'virelia-bot',
            $device: 'virelia-bot'
          }
        }
      }));
    }
  }

  // Update bot status
  async updateStatus() {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[WARN] Cannot update status - not connected to Discord Gateway');
      return;
    }

    try {
      const activeCount = await this.getActiveSubscriptionCount();
      
      if (activeCount === null) {
        console.error('[ERROR] Could not retrieve subscription count for status update');
        return;
      }

      // Force update or only update if count changed
      const forceUpdate = this.lastCount === null;
      if (!forceUpdate && this.lastCount === activeCount) {
        console.log(`[DEBUG] Bot status unchanged: ${activeCount} active subscriptions`);
        return;
      }

      const statusText = activeCount === 1 
        ? `1 Active Subscription` 
        : `${activeCount} Active Subscriptions`;

      // Send presence update
      this.ws.send(JSON.stringify({
        op: 3,
        d: {
          since: null,
          activities: [{
            name: statusText,
            type: 3, // Watching activity type
            state: activeCount > 0 ? 'Managing subscriptions' : 'Ready for subscriptions'
          }],
          status: 'dnd', // Do Not Disturb status
          afk: false
        }
      }));

      // Update nickname if guild is configured
      await this.updateNickname(activeCount);

      this.lastCount = activeCount;
      console.log(`[INFO] Discord bot status updated: ${statusText}`);

    } catch (error) {
      console.error('[ERROR] Failed to update bot status:', error);
    }
  }

  // Update bot nickname in guild
  async updateNickname(count) {
    if (!process.env.DISCORD_GUILD_ID) return;

    try {
      const nickname = count > 0 ? `Virelia (${count})` : 'Virelia';
      await axios.patch(
        `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/@me`,
        { nick: nickname },
        {
          headers: {
            'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      console.log(`[DEBUG] Bot nickname updated to: ${nickname}`);
    } catch (error) {
      console.warn('[WARN] Failed to update bot nickname:', error.response?.data?.message || error.message);
    }
  }

  // Get current active subscription count
  async getActiveSubscriptionCount() {
    try {
      const db = getDB();
      const now = new Date();
      
      const count = await db.collection('subscriptions').countDocuments({
        status: 'active',
        expires_at: { $gt: now }
      });

      return count;
    } catch (error) {
      console.error('[ERROR] Failed to get active subscription count:', error);
      return null;
    }
  }

  // Force status update (called after purchases/expiries)
  async forceStatusUpdate() {
    console.log('[INFO] Force updating Discord bot status...');
    
    if (!this.isConnected) {
      console.log('[WARN] Not connected to Discord, attempting to reconnect...');
      await this.connect();
      return;
    }

    this.lastCount = null; // Force update
    await this.updateStatus();
  }

  // Schedule reconnection with exponential backoff
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[ERROR] Max reconnection attempts reached, giving up');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[INFO] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(() => {
      console.log(`[INFO] Attempting to reconnect (attempt ${this.reconnectAttempts})`);
      this.connect();
    }, delay);
  }

  // Reconnect (close and reestablish connection)
  reconnect() {
    this.cleanup();
    this.connect();
  }

  // Clean up resources
  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000);
      }
      this.ws = null;
    }

    this.isConnected = false;
  }

  // Stop the status manager
  stop() {
    console.log('[INFO] Stopping Discord status manager...');
    this.cleanup();
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent further reconnects
  }

  // Get status info for monitoring
  getStatusInfo() {
    return {
      isConnected: this.isConnected,
      isRunning: this.ws !== null,
      lastCount: this.lastCount,
      isUpdating: this.isUpdating,
      updateMode: 'event-driven',
      reconnectAttempts: this.reconnectAttempts,
      hasSession: !!this.sessionId
    };
  }

  // Health check
  async healthCheck() {
    try {
      const count = await this.getActiveSubscriptionCount();
      const canUpdateStatus = !!process.env.DISCORD_BOT_TOKEN;
      
      return {
        status: this.isConnected ? 'healthy' : 'disconnected',
        active_subscriptions: count,
        can_update_status: canUpdateStatus,
        last_displayed_count: this.lastCount,
        is_updating: this.isUpdating,
        is_connected: this.isConnected,
        updater_running: this.ws !== null,
        update_mode: 'event-driven',
        reconnect_attempts: this.reconnectAttempts,
        gateway_url: this.gatewayUrl ? 'configured' : 'not_configured'
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        can_update_status: !!process.env.DISCORD_BOT_TOKEN,
        is_connected: false,
        update_mode: 'event-driven'
      };
    }
  }

  // Test connection
  async testConnection() {
    try {
      const response = await axios.get('https://discord.com/api/gateway/bot', {
        headers: {
          'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      return {
        success: true,
        session_start_limit: response.data.session_start_limit,
        shards: response.data.shards
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }
}

// Export singleton instance
const discordStatusManager = new DiscordStatusManager();
module.exports = discordStatusManager;