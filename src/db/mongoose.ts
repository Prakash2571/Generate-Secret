import mongoose from 'mongoose';
import { config, redactMongoUrl } from '../config';
import { describeError, logger } from '../utils/logger';
import { CouponModel } from './models/Coupon';
import { CouponObservationModel } from './models/CouponObservation';

let connected = false;

/**
 * Connects to MongoDB using MONGODB_URL / MONGODB_DB from the environment.
 * Works unchanged for a local container or a mongodb+srv:// Atlas cluster.
 */
export async function connectMongo(): Promise<void> {
  if (connected) return;

  mongoose.set('strictQuery', true);

  mongoose.connection.on('disconnected', () => {
    logger.warn('mongodb disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('mongodb reconnected');
  });
  mongoose.connection.on('error', (error: unknown) => {
    logger.error('mongodb connection error', { reason: describeError(error) });
  });

  logger.info('connecting to mongodb', {
    url: redactMongoUrl(config.mongoUrl),
    db: config.mongoDb,
  });

  await mongoose.connect(config.mongoUrl, {
    dbName: config.mongoDb,
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 10,
    retryWrites: true,
    appName: 'shein-coupon-finder',
  });

  connected = true;
  logger.info('mongodb connected', { db: mongoose.connection.name });
}

/** Ensures declared indexes exist (safe to run on every boot). */
export async function syncIndexes(): Promise<void> {
  try {
    await CouponModel.syncIndexes();
    await CouponObservationModel.syncIndexes();
    logger.debug('mongodb indexes synchronised');
  } catch (error) {
    // Index conflicts must not stop the scanner from running.
    logger.warn('index synchronisation skipped', { reason: describeError(error) });
  }
}

export async function disconnectMongo(): Promise<void> {
  if (!connected) return;
  connected = false;
  try {
    await mongoose.connection.close(false);
    logger.info('mongodb connection closed');
  } catch (error) {
    logger.warn('failed to close mongodb cleanly', { reason: describeError(error) });
  }
}

export function isMongoConnected(): boolean {
  return connected && mongoose.connection.readyState === 1;
}
