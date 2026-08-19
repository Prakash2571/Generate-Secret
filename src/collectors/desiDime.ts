import { createCouponSiteCollector } from './genericCouponPage';
import type { Collector } from './types';

/**
 * DesiDime is a community deal forum: useful for fresh reports, but treated as
 * `community` evidence rather than a publisher of official terms.
 */
export const desiDimeCollector: Collector = createCouponSiteCollector({
  name: 'desidime',
  sourceType: 'community',
  description: 'DesiDime community SHEIN deal and coupon threads',
  urls: [
    'https://www.desidime.com/stores/shein',
    'https://www.desidime.com/search?utf8=%E2%9C%93&q=shein+coupon',
  ],
  pageIsAboutShein: true,
});
