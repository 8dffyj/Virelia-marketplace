// config/mongodb.js (Updated with subscriptions collection)
const { MongoClient } = require('mongodb');
require('dotenv').config();

let db = null;
let client = null;

const connectMongoDB = async () => {
  try {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db(process.env.MONGODB_NAME || 'virelia');
    console.log('Connected to MongoDB');
    
    // Create indexes for better performance
    await db.collection('users').createIndex({ "_id": 1 });
    await db.collection('users').createIndex({ "email": 1 });
    
    await db.collection('subscriptions').createIndex({ "user_id": 1 });
    await db.collection('subscriptions').createIndex({ "expires_at": 1 });
    await db.collection('subscriptions').createIndex({ "status": 1 });
    
    await db.collection('transactions').createIndex({ "user_id": 1 });
    await db.collection('transactions').createIndex({ "idempotency_key": 1 }, { unique: true });
    await db.collection('transactions').createIndex({ "created_at": -1 });
    
    console.log('Database indexes created successfully');
    
    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
};

const getDB = () => {
  if (!db) {
    throw new Error('Database not initialized. Call connectMongoDB() first.');
  }
  return db;
};

const getClient = () => {
  if (!client) {
    throw new Error('MongoDB client not initialized. Call connectMongoDB() first.');
  }
  return client;
};

// Graceful shutdown
const closeMongoDB = async () => {
  if (client) {
    await client.close();
    console.log('MongoDB connection closed');
  }
};

module.exports = { connectMongoDB, getDB, getClient, closeMongoDB };