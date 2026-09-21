import mongoose from 'mongoose';
import { config } from './index.js';

let isConnected = false;

export const connectDB = async (): Promise<boolean> => {
  if (isConnected) {
    return true;
  }

  try {
    const conn = await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: 3000, // Timeout fast if local mongo is not running
    });

    isConnected = true;
    console.log(`✅ [MongoDB Connected] Host: ${conn.connection.host}, Database: ${conn.connection.name}`);

    mongoose.connection.on('error', (err) => {
      console.error('❌ [MongoDB Error]:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ [MongoDB Disconnected]');
      isConnected = false;
    });

    return true;
  } catch (error: any) {
    console.warn(`⚠️ [MongoDB Connection Warning] Could not connect to local MongoDB (${config.mongodbUri}): ${error.message}`);
    console.warn(`ℹ️ [Storage Fallback] Operating with in-memory persistent session store until MongoDB is running.`);
    isConnected = false;
    return false;
  }
};

export const isDbConnected = (): boolean => {
  return isConnected && mongoose.connection.readyState === 1;
};

export const disconnectDB = async (): Promise<void> => {
  if (isConnected) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('🔌 [MongoDB Disconnected]');
  }
};
