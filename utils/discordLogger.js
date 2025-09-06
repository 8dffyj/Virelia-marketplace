// utils/discordLogger.js
const axios = require('axios');

class DiscordLogger {
  constructor(webhookUrl, options = {}) {
    this.webhookUrl = webhookUrl;
    this.batchSize = options.batchSize || 10;
    this.batchInterval = options.batchInterval || 5000; // 5 seconds
    this.logQueue = [];
    this.originalConsole = {};
    this.isInitialized = false;

    if (webhookUrl) {
      this.startBatchProcessor();
    }
  }

  init() {
    if (!this.webhookUrl || this.isInitialized) return;

    // Store original console methods
    this.originalConsole.log = console.log;
    this.originalConsole.error = console.error;
    this.originalConsole.warn = console.warn;
    this.originalConsole.info = console.info;

    // Override console methods
    console.log = (...args) => {
      this.originalConsole.log(...args);
      this.addToQueue('INFO', args);
    };

    console.error = (...args) => {
      this.originalConsole.error(...args);
      this.addToQueue('ERROR', args);
    };

    console.warn = (...args) => {
      this.originalConsole.warn(...args);
      this.addToQueue('WARN', args);
    };

    console.info = (...args) => {
      this.originalConsole.info(...args);
      this.addToQueue('INFO', args);
    };

    this.isInitialized = true;
    console.log('[INFO] Discord logger initialized');
  }

  addToQueue(level, args) {
    if (!this.webhookUrl) return;

    const message = args.map(arg => {
      if (typeof arg === 'object') {
        return JSON.stringify(arg, null, 2);
      }
      return String(arg);
    }).join(' ');

    const timestamp = new Date().toISOString();
    this.logQueue.push(`[${timestamp}] [${level}] ${message}`);

    // Send immediately if queue is full
    if (this.logQueue.length >= this.batchSize) {
      this.sendBatch();
    }
  }

  startBatchProcessor() {
    setInterval(() => {
      if (this.logQueue.length > 0) {
        this.sendBatch();
      }
    }, this.batchInterval);
  }

  async sendBatch() {
    if (!this.webhookUrl || this.logQueue.length === 0) return;

    const logs = this.logQueue.splice(0, this.batchSize);
    const content = logs.join('\n');

    // Split content if it's too long for Discord (2000 char limit)
    const chunks = this.splitContent(content, 1900);

    for (const chunk of chunks) {
      try {
        await axios.post(this.webhookUrl, {
          content: `\`\`\`\n${chunk}\n\`\`\``
        });
      } catch (error) {
        // Use original console to avoid infinite loop
        this.originalConsole.error('Failed to send logs to Discord:', error.message);
      }
    }
  }

  splitContent(content, maxLength) {
    const chunks = [];
    let currentChunk = '';

    for (const line of content.split('\n')) {
      if (currentChunk.length + line.length + 1 > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }
        
        // If single line is too long, truncate it
        if (line.length > maxLength) {
          chunks.push(line.substring(0, maxLength - 3) + '...');
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  restore() {
    if (!this.isInitialized) return;

    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.info = this.originalConsole.info;

    this.isInitialized = false;
    console.log('Discord logger restored');
  }

  // Manual logging methods (bypass console override)
  logDirect(level, message) {
    if (!this.webhookUrl) return;
    
    const timestamp = new Date().toISOString();
    this.logQueue.push(`[${timestamp}] [${level}] ${message}`);
  }
}

// Singleton instance
let discordLogger = null;

const initDiscordLogger = (webhookUrl, options) => {
  if (!discordLogger) {
    discordLogger = new DiscordLogger(webhookUrl, options);
  }
  return discordLogger;
};

const getDiscordLogger = () => discordLogger;

module.exports = { DiscordLogger, initDiscordLogger, getDiscordLogger };