import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function num(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  let value = parsed;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const DEFAULT_USER_AGENT =
  'SheinCouponFinder/1.0 (+public coupon research bot; respects robots and rate limits)';

export interface AppConfig {
  mongoUrl: string;
  mongoDb: string;

  scanIntervalMinutes: number;
  validationIntervalMinutes: number;

  maxConcurrentRequests: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  userAgent: string;

  targetCartValue: number;
  targetDiscount: number;
  /** Cart values the discount calculator always reports on. */
  cartValueLadder: number[];

  revalidateValidAfterHours: number;
  revalidateUnverifiedAfterHours: number;
  revalidateInvalidAfterHours: number;
  staleSourceAfterDays: number;

  headless: boolean;
  browserTimeoutMs: number;
  enableCartValidation: boolean;
  maxCartValidationsPerCycle: number;

  maxCandidatesPerCollector: number;
  maxValidationsPerCycle: number;

  /** Render JS-heavy pages with Chromium when plain HTTP yields nothing. */
  enableBrowserFallback: boolean;
  /** Optional documented search APIs (no scraping of blocked endpoints). */
  braveApiKey: string;
  serpApiKey: string;
  /** Optional Reddit OAuth app credentials for the sanctioned API. */
  redditClientId: string;
  redditClientSecret: string;
  /** Extra public coupon pages to include, comma-separated. */
  extraSourceUrls: string[];
  /** How many search-result pages to open per cycle. */
  searchResultPagesToFetch: number;
  /** Freshness-first search queries (specification section 10). */
  searchQueries: string[];

  runOnce: boolean;
  reportOnly: boolean;
  resultsDir: string;
  shutdownTimeoutMs: number;

  logLevel: string;
  nodeEnv: string;
}

export const config: AppConfig = {
  // Credentials are never hardcoded: the URL always comes from the environment.
  mongoUrl: str('MONGODB_URL', ''),
  mongoDb: str('MONGODB_DB', 'shein_coupon_finder'),

  scanIntervalMinutes: num('SCAN_INTERVAL_MINUTES', 30, 1),
  validationIntervalMinutes: num('VALIDATION_INTERVAL_MINUTES', 60, 1),

  maxConcurrentRequests: num('MAX_CONCURRENT_REQUESTS', 3, 1, 16),
  requestDelayMs: num('REQUEST_DELAY_MS', 2000, 0),
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 20_000, 1000),
  maxRetries: num('MAX_RETRIES', 2, 0, 6),
  userAgent: str('USER_AGENT', DEFAULT_USER_AGENT),

  targetCartValue: num('TARGET_CART_VALUE', 1000, 1),
  targetDiscount: num('TARGET_DISCOUNT', 800, 1),
  cartValueLadder: [999, 1000, 1099, 1199, 1299, 1499, 1999],

  revalidateValidAfterHours: num('REVALIDATE_VALID_AFTER_HOURS', 24, 1),
  revalidateUnverifiedAfterHours: num('REVALIDATE_UNVERIFIED_AFTER_HOURS', 6, 1),
  revalidateInvalidAfterHours: num('REVALIDATE_INVALID_AFTER_HOURS', 72, 1),
  staleSourceAfterDays: num('STALE_SOURCE_AFTER_DAYS', 30, 1),

  headless: bool('HEADLESS', true),
  browserTimeoutMs: num('BROWSER_TIMEOUT_MS', 45_000, 5000),
  enableCartValidation: bool('ENABLE_CART_VALIDATION', true),
  maxCartValidationsPerCycle: num('MAX_CART_VALIDATIONS_PER_CYCLE', 5, 0, 50),

  maxCandidatesPerCollector: num('MAX_CANDIDATES_PER_COLLECTOR', 60, 1),
  maxValidationsPerCycle: num('MAX_VALIDATIONS_PER_CYCLE', 40, 1),

  enableBrowserFallback: bool('ENABLE_BROWSER_FALLBACK', true),
  braveApiKey: str('BRAVE_SEARCH_API_KEY', ''),
  serpApiKey: str('SERPAPI_KEY', ''),
  redditClientId: str('REDDIT_CLIENT_ID', ''),
  redditClientSecret: str('REDDIT_CLIENT_SECRET', ''),
  extraSourceUrls: str('EXTRA_SOURCE_URLS', '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
  searchResultPagesToFetch: num('SEARCH_RESULT_PAGES_TO_FETCH', 5, 0, 25),
  searchQueries: [
    'SHEIN India 800 off 1000',
    'SHEIN \u20b9800 coupon India',
    'SHEIN 80% off coupon India',
    'SHEIN India new user \u20b9800 off',
    'SHEIN India first order coupon',
    'SHEIN India 1000 off coupon',
    'SHEIN India 800 discount',
    'SHEIN 800 off minimum 1000',
    'SHEIN flash sale India 80%',
    'SHEIN India first order 80%',
    'SHEIN India new account offer',
    'SHEIN India coupon today',
    `SHEIN India coupon ${new Date().toLocaleString('en-US', { month: 'long' })} ${new Date().getFullYear()}`,
  ],

  runOnce: bool('RUN_ONCE', false),
  reportOnly: bool('REPORT_ONLY', false),
  resultsDir: str('RESULTS_DIR', path.resolve(process.cwd(), 'results')),
  shutdownTimeoutMs: num('SHUTDOWN_TIMEOUT_MS', 25_000, 2000),

  logLevel: str('LOG_LEVEL', 'info'),
  nodeEnv: str('NODE_ENV', 'production'),
};

/** Ensures the target cart value is always part of the reported ladder. */
if (!config.cartValueLadder.includes(config.targetCartValue)) {
  config.cartValueLadder = [...config.cartValueLadder, config.targetCartValue].sort(
    (a, b) => a - b,
  );
}

export function assertConfig(): void {
  const problems: string[] = [];

  if (!config.mongoUrl) {
    problems.push(
      'MONGODB_URL is not set. Copy .env.example to .env and set MONGODB_URL ' +
        '(e.g. mongodb://mongodb:27017 or a mongodb+srv:// Atlas URL).',
    );
  } else if (!/^mongodb(\+srv)?:\/\//.test(config.mongoUrl)) {
    problems.push('MONGODB_URL must start with mongodb:// or mongodb+srv://');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Redacts credentials so the URL can be logged safely. */
export function redactMongoUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, '//***:***@');
}
