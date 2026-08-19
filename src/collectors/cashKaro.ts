import { createCouponSiteCollector } from './genericCouponPage';
import type { Collector } from './types';

/** CashKaro's public SHEIN store/coupon pages. */
export const cashKaroCollector: Collector = createCouponSiteCollector({
  name: 'cashkaro',
  sourceType: 'coupon-site',
  description: 'CashKaro public SHEIN coupon and cashback pages',
  urls: [
    'https://cashkaro.com/stores/shein',
    'https://cashkaro.com/coupons/shein',
  ],
  pageIsAboutShein: true,
  waitForSelector: '[class*="coupon" i], [class*="offer" i]',
});
