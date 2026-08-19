import { createCouponSiteCollector } from './genericCouponPage';
import type { Collector } from './types';

/** CouponDunia's public SHEIN store page. */
export const couponDuniaCollector: Collector = createCouponSiteCollector({
  name: 'coupondunia',
  sourceType: 'coupon-site',
  description: 'CouponDunia public SHEIN store page',
  urls: ['https://www.coupondunia.in/shein', 'https://www.coupondunia.in/shein/coupons'],
  pageIsAboutShein: true,
  waitForSelector: '[class*="coupon" i], [class*="offer" i]',
});
