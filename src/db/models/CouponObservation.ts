import mongoose, { Schema, type HydratedDocument, type Model, type Types } from 'mongoose';
import type { CouponStatus, DiscountType, SourceType } from '../../types';

/**
 * Why an observation was written. Together these let you replay the life of an
 * offer: appeared -> became valid -> conditions changed -> invalid -> expired.
 */
export type ObservationEvent =
  | 'discovered'
  | 'rediscovered'
  | 'terms_changed'
  | 'validated'
  | 'status_changed'
  | 'expired'
  | 'confidence_changed';

export interface ICouponObservation {
  couponId: Types.ObjectId;
  code?: string;
  event: ObservationEvent;
  status: CouponStatus;
  previousStatus?: CouponStatus;

  source?: {
    name: string;
    url: string;
    type: SourceType;
  };

  discountType?: DiscountType;
  discountValue?: number;
  minimumOrder?: number;
  maximumDiscount?: number;

  confidence?: number;
  validationResult?: string;
  validationMethod?: string;
  /** Human-readable diff, e.g. ["minimumOrder: 999 -> 1299"]. */
  changes?: string[];

  observedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type CouponObservationDocument = HydratedDocument<ICouponObservation>;

const CouponObservationSchema = new Schema<ICouponObservation>(
  {
    couponId: { type: Schema.Types.ObjectId, required: true, ref: 'Coupon' },
    code: { type: String, uppercase: true, trim: true },
    event: {
      type: String,
      required: true,
      enum: [
        'discovered',
        'rediscovered',
        'terms_changed',
        'validated',
        'status_changed',
        'expired',
        'confidence_changed',
      ],
    },
    status: {
      type: String,
      required: true,
      enum: ['valid', 'invalid', 'expired', 'unverified', 'manual_validation_required'],
    },
    previousStatus: {
      type: String,
      enum: ['valid', 'invalid', 'expired', 'unverified', 'manual_validation_required'],
    },

    source: {
      name: { type: String },
      url: { type: String },
      type: {
        type: String,
        enum: ['official', 'coupon-site', 'social', 'community', 'other'],
      },
    },

    discountType: { type: String, enum: ['flat', 'percentage', 'sale', 'cashback', 'unknown'] },
    discountValue: { type: Number },
    minimumOrder: { type: Number },
    maximumDiscount: { type: Number },

    confidence: { type: Number },
    validationResult: { type: String },
    validationMethod: { type: String },
    changes: { type: [String], default: undefined },

    observedAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    collection: 'coupon_observations',
  },
);

// History is always read per coupon, newest first.
CouponObservationSchema.index({ couponId: 1, observedAt: -1 }, { name: 'idx_coupon_observedAt' });
CouponObservationSchema.index({ observedAt: -1 }, { name: 'idx_observedAt' });
CouponObservationSchema.index({ code: 1, observedAt: -1 }, { name: 'idx_code_observedAt' });
CouponObservationSchema.index({ event: 1 }, { name: 'idx_event' });

export const CouponObservationModel: Model<ICouponObservation> =
  (mongoose.models.CouponObservation as Model<ICouponObservation> | undefined) ??
  mongoose.model<ICouponObservation>('CouponObservation', CouponObservationSchema);
