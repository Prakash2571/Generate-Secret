import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import type { CouponStatus, DiscountType, SourceType } from '../../types';

/** What one specific page claimed about this coupon. Kept for lineage checks. */
export interface CouponSourceEntry {
  name: string;
  url: string;
  type: SourceType;
  domain?: string;
  discoveredAt: Date;
  lastSeenAt: Date;
  snippet?: string;
  claim?: {
    discountType?: DiscountType;
    discountValue?: number;
    minimumOrder?: number;
    maximumDiscount?: number;
  };
  /** The page presented this offer as expired / no longer working. */
  reportedExpired?: boolean;
}

export interface ICoupon {
  code?: string;
  title?: string;

  discountType: DiscountType;
  discountValue?: number;
  minimumOrder?: number;
  maximumDiscount?: number;

  currency: 'INR';
  country: 'India';

  /** Advertised value is an upper bound ("up to 80% off"), not a guarantee. */
  isUpTo: boolean;
  /** The minimum order was explicitly published, not inferred. */
  minimumOrderKnown: boolean;

  newUsersOnly?: boolean;
  existingUsersAllowed?: boolean;
  appOnly?: boolean;
  selectedUsersOnly?: boolean;
  selectedProductsOnly?: boolean;
  firstOrderOnly?: boolean;

  expiryDate?: Date;

  status: CouponStatus;
  confidence: number;

  sourceCount: number;
  sources: CouponSourceEntry[];

  /** Stable dedupe key: the code when present, otherwise an offer fingerprint. */
  dedupeKey: string;
  /** True when independent sources publish materially different terms. */
  conflictingSources: boolean;
  /** At least one source is an official SHEIN customer-facing page. */
  hasOfficialSource: boolean;

  /** Cached target analysis (recomputed on every write) for queries/sorting. */
  targetMatch: boolean;
  discountAtTarget?: number;
  finalPriceAtTarget?: number;
  effectiveDiscountAtTarget?: number;

  firstSeenAt: Date;
  lastSeenAt: Date;
  lastValidatedAt?: Date;
  validationMethod?: string;
  validationNotes?: string;

  /** Last time a real customer-facing coupon field accepted this code. */
  cartAcceptedAt?: Date;
  /** Last time the code was found on an official SHEIN customer-facing page. */
  officialConfirmedAt?: Date;

  validationAttempts: number;

  createdAt: Date;
  updatedAt: Date;
}

export type CouponDocument = HydratedDocument<ICoupon>;

const SourceSchema = new Schema<CouponSourceEntry>(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['official', 'coupon-site', 'social', 'community', 'other'],
    },
    domain: { type: String },
    discoveredAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    snippet: { type: String },
    claim: {
      discountType: { type: String, enum: ['flat', 'percentage', 'sale', 'cashback', 'unknown'] },
      discountValue: { type: Number },
      minimumOrder: { type: Number },
      maximumDiscount: { type: Number },
    },
    reportedExpired: { type: Boolean },
  },
  { _id: false },
);

const CouponSchema = new Schema<ICoupon>(
  {
    code: { type: String, trim: true, uppercase: true },
    title: { type: String, trim: true },

    discountType: {
      type: String,
      required: true,
      enum: ['flat', 'percentage', 'sale', 'cashback', 'unknown'],
      default: 'unknown',
    },
    discountValue: { type: Number, min: 0 },
    minimumOrder: { type: Number, min: 0 },
    maximumDiscount: { type: Number, min: 0 },

    currency: { type: String, required: true, default: 'INR', enum: ['INR'] },
    country: { type: String, required: true, default: 'India', enum: ['India'] },

    isUpTo: { type: Boolean, required: true, default: false },
    minimumOrderKnown: { type: Boolean, required: true, default: false },

    newUsersOnly: { type: Boolean },
    existingUsersAllowed: { type: Boolean },
    appOnly: { type: Boolean },
    selectedUsersOnly: { type: Boolean },
    selectedProductsOnly: { type: Boolean },
    firstOrderOnly: { type: Boolean },

    expiryDate: { type: Date },

    status: {
      type: String,
      required: true,
      enum: ['valid', 'invalid', 'expired', 'unverified', 'manual_validation_required'],
      default: 'unverified',
    },
    confidence: { type: Number, required: true, default: 0, min: 0, max: 100 },

    sourceCount: { type: Number, required: true, default: 0 },
    sources: { type: [SourceSchema], default: [] },

    dedupeKey: { type: String, required: true },
    conflictingSources: { type: Boolean, required: true, default: false },
    hasOfficialSource: { type: Boolean, required: true, default: false },

    targetMatch: { type: Boolean, required: true, default: false },
    discountAtTarget: { type: Number },
    finalPriceAtTarget: { type: Number },
    effectiveDiscountAtTarget: { type: Number },

    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    lastValidatedAt: { type: Date },
    validationMethod: { type: String },
    validationNotes: { type: String },

    cartAcceptedAt: { type: Date },
    officialConfirmedAt: { type: Date },

    validationAttempts: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: true,
    collection: 'coupons',
    minimize: false,
  },
);

// One document per real-world offer: rediscovery updates, never duplicates.
CouponSchema.index({ dedupeKey: 1 }, { unique: true, name: 'uniq_dedupeKey' });
CouponSchema.index({ code: 1 }, { name: 'idx_code', sparse: true });
CouponSchema.index({ status: 1 }, { name: 'idx_status' });
CouponSchema.index({ lastSeenAt: -1 }, { name: 'idx_lastSeenAt' });
CouponSchema.index({ lastValidatedAt: 1 }, { name: 'idx_lastValidatedAt' });
CouponSchema.index({ expiryDate: 1 }, { name: 'idx_expiryDate', sparse: true });
CouponSchema.index({ confidence: -1 }, { name: 'idx_confidence' });
// Ranking query: cheapest verified payment on the target cart value first.
CouponSchema.index(
  { status: 1, finalPriceAtTarget: 1, confidence: -1 },
  { name: 'idx_status_target_confidence' },
);

export const CouponModel: Model<ICoupon> =
  (mongoose.models.Coupon as Model<ICoupon> | undefined) ??
  mongoose.model<ICoupon>('Coupon', CouponSchema);
