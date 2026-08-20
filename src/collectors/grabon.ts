import { createCouponSiteCollector } from './genericCouponPage';
import type { Collector } from './types';

/** GrabOn's public SHEIN coupon listing. */
export const grabonCollector: Collector = createCouponSiteCollector({
  name: 'grabon',
  sourceType: 'coupon-site',
  description: 'GrabOn public SHEIN coupon pages',
  urls: ['https://www.grabon.in/shein-coupons/'],
  pageIsAboutShein: true,
  waitForSelector: '[class*="coupon" i], [class*="offer" i]',
});
