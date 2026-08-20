# SHEIN India — Public Coupon Discovery & Validation Service

Continuously discovers **publicly published** SHEIN India coupons and promotions, validates them
through legitimate customer-facing mechanisms where that is possible, stores every observation in
MongoDB, and maintains a ranked list of currently valid offers.

Ranking is optimised for one target: **≈ ₹800 off a ₹1,000 cart (~80% effective) in India.**

```
discover → extract → deduplicate → validate → store → rescore → revalidate → rank → report
```

## What this service will and will not do

It only reads offers that someone has already published in public, and it only validates them the
way a shopper would.

**Never done, by design and enforced in code:**

- no brute-forcing or generating coupon codes against any API
- no CAPTCHA / anti-bot / rate-limit circumvention (a challenge ends that check, see `ChallengeError`)
- no fake accounts, no referral abuse, no login, no OTP requests
- no orders, no payment details — checkout/payment URLs are hard-blocked in `BrowserManager`
- `robots.txt` (including `Crawl-delay`) is respected on every request

When validation would require any of the above, the coupon is recorded as
`manual_validation_required` and the scan moves on.

---

## Requirements

- Docker with Compose v2 (`docker compose`)
- A MongoDB URL — either the bundled container or any external/Atlas cluster
- ~2 GB free disk for the image (it includes Chromium)

Running without Docker additionally needs Node.js 20+ and `npx playwright install chromium`.

---

## Configuration

All configuration comes from the environment. **No credentials are hardcoded.**

```bash
cp .env.example .env
# then set MONGODB_URL
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONGODB_URL` | *(required)* | `mongodb://mongodb:27017` or `mongodb+srv://…` |
| `MONGODB_DB` | `shein_coupon_finder` | Database name |
| `SCAN_INTERVAL_MINUTES` | `30` | Discovery cadence |
| `VALIDATION_INTERVAL_MINUTES` | `60` | Revalidation cadence |
| `MAX_CONCURRENT_REQUESTS` | `3` | Global request concurrency cap |
| `REQUEST_DELAY_MS` | `2000` | Minimum delay **per domain** |
| `REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout |
| `MAX_RETRIES` | `2` | Retries with exponential backoff + jitter |
| `TARGET_CART_VALUE` | `1000` | Cart value used for ranking |
| `TARGET_DISCOUNT` | `800` | Discount that earns `TARGET_MATCH` |
| `REVALIDATE_VALID_AFTER_HOURS` | `24` | Staleness threshold for `valid` |
| `REVALIDATE_UNVERIFIED_AFTER_HOURS` | `6` | Staleness threshold for `unverified` / `manual` |
| `REVALIDATE_INVALID_AFTER_HOURS` | `72` | Offers sometimes come back |
| `STALE_SOURCE_AFTER_DAYS` | `30` | Beyond this a source stops corroborating |
| `HEADLESS` | `true` | Chromium mode |
| `ENABLE_CART_VALIDATION` | `true` | Allow the coupon-field check |
| `MAX_CART_VALIDATIONS_PER_CYCLE` | `5` | Budget for browser checks per cycle |
| `ENABLE_BROWSER_FALLBACK` | `true` | Render JS-heavy pages when HTTP yields nothing |
| `MAX_CANDIDATES_PER_COLLECTOR` | `60` | Per-collector cap |
| `MAX_VALIDATIONS_PER_CYCLE` | `40` | Validation queue size |
| `RESULTS_DIR` | `/app/results` | Where reports are written |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | Hard bound on the shutdown sequence |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `RUN_ONCE` | `false` | One cycle, print, exit |
| `REPORT_ONLY` | `false` | Print stored state without scanning |
| `BRAVE_SEARCH_API_KEY` | *(empty)* | Optional, enables reliable search discovery |
| `SERPAPI_KEY` | *(empty)* | Optional search alternative |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | *(empty)* | Optional, uses Reddit's official API |
| `EXTRA_SOURCE_URLS` | *(empty)* | Comma-separated extra public pages to scan |

`.env` is git-ignored and must never be committed.

### Local MongoDB setup

The default works out of the box — `docker compose` starts `mongo:8` and the app waits for its
healthcheck:

```env
MONGODB_URL=mongodb://mongodb:27017
MONGODB_DB=shein_coupon_finder
```

Data lives in the named volume `shein_coupon_mongodb_data`, so history survives restarts.
To inspect it from the host, uncomment the `ports` block on the `mongodb` service.

### MongoDB Atlas setup

1. Create a free cluster at cloud.mongodb.com.
2. **Database Access** → add a user with *Read and write to any database*.
3. **Network Access** → allow the IP running this service (`0.0.0.0/0` only for quick tests).
4. **Connect → Drivers** → copy the connection string into `.env`:

```env
MONGODB_URL=mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/
MONGODB_DB=shein_coupon_finder
```

No source change is required. URL-encode special characters in the password (`@` → `%40`).
With Atlas the local database container is unnecessary:

```bash
docker compose up --build --no-deps app
```

---

## Docker usage

```bash
docker compose up --build      # build and run in the foreground
docker compose up -d           # run detached
docker compose logs -f app     # follow logs
docker compose down            # stop; KEEPS the MongoDB volume
docker compose down -v         # stop and DELETE the volume (loses all history)
```

`docker compose down` removes containers and the network but leaves `shein_coupon_mongodb_data`
intact — coupon history is preserved. Only the explicit `-v` flag destroys it.

### Starting

```bash
cp .env.example .env
# set MONGODB_URL
docker compose up --build
```

On boot the service connects to MongoDB, ensures indexes, loads existing coupon history, runs a
discovery pass, validates, prints the table, writes `results/`, then sleeps until the next scan.

### Stopping

Press `Ctrl+C` (or run `docker compose down`). The process does **not** die immediately; it runs the
shutdown sequence:

1. stop scheduling new scans
2. let current safe operations finish (bounded wait)
3. close all Playwright browsers
4. read the latest state from MongoDB, sort best → worst, print the final report
5. write the JSON and CSV reports
6. close MongoDB and exit

`stop_grace_period: 30s` in Compose gives it room; `SHUTDOWN_TIMEOUT_MS` guarantees it never hangs.
Pressing `Ctrl+C` a second time exits immediately. The handler never starts a new scan.

### Viewing logs

```bash
docker compose logs -f app
docker compose logs -f app | grep -E "\[(VALID|INVALID|MANUAL|TARGET)"
LOG_LEVEL=debug docker compose up   # verbose
```

Log lines are structured, e.g.:

```
[INFO] Discovery started collectors=officialShein,grabon,...
[INFO] grabon: 14 candidate offers withCodes=9 took=6.1s
[INFO] Deduplicated: 17 unique candidates from=31
[VALIDATE] SHEIN800 status=unverified sources=3
[VALID] SHEIN800 — ₹800 OFF (min ₹1,000) method=official-publication confidence=95
[UNVERIFIED] NEWUSER80 — UP TO 80% OFF method=public-sources-only
[ERROR] collector failed collector=grabon reason="request timeout"
```

### Viewing results

`./results` is bind-mounted, so files are readable on the host even after the containers stop:

| File | Contents |
| --- | --- |
| `results/latest.json` | Every coupon with full analysis, confidence factors and source lineage |
| `results/latest.csv` | The same, flattened for spreadsheets |
| `results/valid-coupons.json` | Only coupons proven valid |
| `results/valid-coupons.csv` | The same, flattened |

They are rewritten after every scan **and** during shutdown.

```bash
jq '.best, .targetMatches[].code' results/latest.json
column -s, -t results/valid-coupons.csv | less -S
```

If the container cannot write there, the log prints the fix: `sudo chown -R 1000:1000 ./results`
(the app runs as uid 1000, not root).

---

## Database schemas

### `coupons`

One document per real-world offer. Rediscovery updates it — duplicates are never created.

| Field | Notes |
| --- | --- |
| `code` | Normalised `trim().toUpperCase()`; absent for code-less promotions |
| `title` | Short human label |
| `discountType` | `flat` / `percentage` / `sale` / `cashback` / `unknown` |
| `discountValue`, `minimumOrder`, `maximumDiscount` | Parsed terms |
| `isUpTo` | **True when the value is only an upper bound** ("up to 80% off") |
| `minimumOrderKnown` | True only when a minimum was actually published |
| `currency` / `country` | `INR` / `India` |
| `newUsersOnly`, `existingUsersAllowed`, `appOnly`, `selectedUsersOnly`, `selectedProductsOnly`, `firstOrderOnly` | Eligibility flags |
| `expiryDate` | Parsed expiry |
| `status` | `valid` / `invalid` / `expired` / `unverified` / `manual_validation_required` |
| `confidence` | 0–100, independent of `status` |
| `sourceCount`, `sources[]` | Every publisher, with `type`, `discoveredAt`, `lastSeenAt`, its own `claim` and `reportedExpired` |
| `dedupeKey` | Unique key: the code, or a fingerprint of the terms |
| `conflictingSources` | Publishers disagree on the terms |
| `hasOfficialSource`, `officialConfirmedAt`, `cartAcceptedAt` | Evidence markers |
| `targetMatch`, `discountAtTarget`, `finalPriceAtTarget`, `effectiveDiscountAtTarget` | Cached target analysis |
| `firstSeenAt`, `lastSeenAt`, `lastValidatedAt` | Freshness |
| `validationMethod`, `validationNotes`, `validationAttempts` | Why the status is what it is |
| `createdAt`, `updatedAt` | Timestamps |

Indexes: `dedupeKey` (unique), `code`, `status`, `lastSeenAt`, `lastValidatedAt`, `expiryDate`,
`confidence`, and a compound `status + finalPriceAtTarget + confidence` for ranking queries.

### `coupon_observations`

Append-only history — nothing is ever overwritten, so an offer's life can be replayed:

```
discovered → rediscovered → terms_changed → validated → status_changed → expired
```

Fields: `couponId`, `code`, `event`, `status`, `previousStatus`, `source`, `discountType`,
`discountValue`, `minimumOrder`, `maximumDiscount`, `confidence`, `validationResult`,
`validationMethod`, `changes[]` (e.g. `"minimumOrder: 999 -> 1299"`), `observedAt`.

```js
// how a coupon's conditions evolved
db.coupon_observations.find({ code: "SHEIN800" }).sort({ observedAt: 1 })
```

---

## Adding collectors

Each source is an independent module in `src/collectors/`. A failing collector is caught, logged and
skipped — it can never break a scan.

For a normal public coupon page, the factory is enough:

```ts
// src/collectors/myCouponSite.ts
import { createCouponSiteCollector } from './genericCouponPage';

export const myCouponSiteCollector = createCouponSiteCollector({
  name: 'mycouponsite',
  sourceType: 'coupon-site',        // official | coupon-site | social | community | other
  description: 'MyCouponSite public SHEIN page',
  urls: ['https://www.mycouponsite.in/shein-coupons/'],
  pageIsAboutShein: true,
});
```

Then register it in `src/collectors/index.ts`. For anything unusual (an API, a JSON feed) implement
the `Collector` interface directly — see `reddit.ts` and `searchEngine.ts`.

No code change is needed just to try a page: put it in `EXTRA_SOURCE_URLS` and the `generic`
collector picks it up.

Current collectors: `officialShein`, `searchEngine`, `grabon`, `couponDunia`, `cashKaro`,
`desiDime`, `reddit`, `generic`.

---

## Validation rules

Evidence is assessed in a strict cascade (first match wins):

| Step | Evidence | Result |
| --- | --- | --- |
| 1 | Published expiry has passed | `expired` |
| 2 | Currently published on an official SHEIN India page (≤48 h) | `valid` |
| 3 | The normal coupon field **accepted** the code | `valid` (+`cartAcceptedAt`) |
| 3 | The coupon field **explicitly rejected** it | `invalid` |
| 3 | Recognised but conditions unmet (e.g. minimum spend) | `manual_validation_required` + observed terms |
| 3 | Sign-in / OTP / CAPTCHA / anti-bot encountered | `manual_validation_required` |
| 4 | Official page, or ≥2 independent domains, report it expired | `invalid` |
| 5 | Only third-party publications | `unverified` |

**Third-party copies never produce `valid`.** Ten affiliate sites repeating one another is not ten
confirmations; corroboration is capped at +15 confidence and counted per registrable domain.

Confidence (0–100) is separate from status — `confidence: 80, status: unverified` is normal:

| Signal | Points |
| --- | --- |
| Accepted by legitimate cart validation (≤48 h) | +50 |
| Current official SHEIN source (≤7 d) | +35 |
| Second / third independent recent source | +10 / +5 |
| Seen within 24 h / 7 days | +10 / +5 |
| Not seen for over 30 days | −20 |
| Sources disagree on terms | −20 |
| Reported expired or past expiry | −50 |

### Offer maths

`calculateDiscount(coupon, cartValue)` and `calculateFinalPrice(coupon, cartValue)` are reported for
₹999, ₹1000, ₹1099, ₹1199, ₹1299, ₹1499 and ₹1999, and are deliberately conservative:

- `up to X% off` yields **no** guaranteed discount
- a store-wide `sale` is not a cart coupon; `cashback` does not reduce the amount payable
- a cart below a *published* minimum yields nothing
- an unpublished minimum is computed optimistically but flagged `uncertain`

`TARGET_MATCH` requires ≥ ₹800 off with ≤ ₹200 payable **and** fully published terms. Offers that
would qualify only under assumptions are reported as `POTENTIAL_TARGET_MATCH` instead.

Ranking order: validity → lowest payable price on ₹1,000 → effective discount → confidence →
freshness → independent sources. Never the advertised percentage: "80% off, max ₹300" (pay ₹700)
correctly ranks below "₹600 off ₹1,000" (pay ₹400).

---

## Known limitations

- **Cart validation usually cannot complete.** SHEIN's coupon field generally needs a signed-in
  session and a cart with items, and the site is behind anti-bot protection. Since none of that will
  be worked around, most coded offers realistically settle at `manual_validation_required`. That is
  the honest outcome, not a bug — verify the shortlist by hand in the app or on the site.
- **`valid` is rare on purpose.** Without official confirmation or a real acceptance, offers stay
  `unverified`. The service is built to avoid false positives.
- **Search discovery needs a key for good coverage.** Scraping Google/Bing result pages breaks their
  terms, so the service prefers the Brave Search or SerpApi APIs. Without a key it tries
  DuckDuckGo's no-JS endpoint and skips it if `robots.txt` disallows it. Reddit behaves the same way
  (official API when credentials are set).
- **Coupon-site layouts change.** Selectors and URLs will drift; a source that stops yielding
  candidates logs a warning rather than failing. Check `results/latest.json` source lineage.
- **App-only offers cannot be verified**, only identified from published text and flagged.
- **Selected-user offers are account-specific** — they are labelled clearly and can never be
  confirmed generically.
- **Parsing is deterministic, not perfect.** Unusual phrasing may be missed; the raw snippet is kept
  on each source entry so anything questionable can be audited.
- **`docker compose up --build` needs network access** for npm and the Docker registry, and pulls
  Chromium (~400 MB) on first build.

## Project layout

```
src/
├── collectors/   one module per source + registry (index.ts)
├── extractors/   couponExtractor.ts, promotionParser.ts (deterministic parsing)
├── validators/   couponValidator.ts (evidence cascade), cartValidator.ts (coupon field)
├── scoring/      confidence.ts, ranking.ts
├── calculations/ discount.ts (ladder + target analysis)
├── browser/      BrowserManager.ts (shared Chromium), renderPage.ts
├── db/           mongoose.ts, couponRepository.ts, models/
├── services/     discoveryService, validationService, reportService, scheduler, state
├── utils/        logger, httpClient, robots, retry, concurrency, shutdown, table, time
├── config.ts     environment configuration
└── index.ts      entry point + shutdown wiring
```

## Local development (without Docker)

```bash
npm install
npx playwright install --with-deps chromium
npm run build
MONGODB_URL=mongodb://localhost:27017 npm start

npm run typecheck          # types only
npm test                   # compile + run the test suite
RUN_ONCE=true npm start    # single cycle then exit
REPORT_ONLY=true npm start # print stored state, no scanning
```

## Tests

```bash
npm test          # compiles to dist-test/ then runs the suite
npm run test:run  # re-run without recompiling
```

The suite uses Node's built-in test runner (`node --test`), so there is **no
extra test dependency to install** and it works on Node 20 and 22. It runs
offline in a couple of seconds: no network, no MongoDB and no browser is ever
started.

What is covered, and why it matters:

| File | Locks down |
| --- | --- |
| `promotionParser.test.ts` | The accuracy rules: `UP TO 80% OFF SALE` is not an 80% coupon, `70% off up to ₹700` is a capped percentage, `₹800 off` is not tied to ₹1,000 unless published, cashback ≠ discount, expiry and restriction parsing |
| `couponExtractor.test.ts` | Code detection vs. prose (`SHEIN`, `1000`, `use code at checkout` are not codes), snippet extraction, JSON-LD, per-page caps |
| `discount.test.ts` | The ₹999–₹1999 ladder, caps, minimum-order refusal, `TARGET_MATCH` vs. `POTENTIAL_TARGET_MATCH` |
| `confidence.test.ts` | Every point rule, the third-party cap, clamping to 0–100 |
| `ranking.test.ts` | Validity first, then payable price; the "80% off max ₹300 loses to ₹600 off" case |
| `couponRepository.test.ts` | Code normalisation, dedupe keys, conflict detection, expiry sweep, revalidation thresholds |
| `couponValidator.test.ts` | The whole evidence cascade, including that third-party copies never reach `valid` |
| `cartValidator.test.ts` | Response classification, and that a login/OTP/CAPTCHA wall is `blocked`, never a coupon verdict |
| `reportService.test.ts` | Status groups never mixed, report wording, all four output files, CSV escaping |
| `shutdown.test.ts` | Step order, failure isolation, per-step timeouts, idempotency |
| `robots.test.ts`, `utils.test.ts` | robots.txt parsing, retry/backoff, concurrency limits, per-domain delay, table rendering |
| `discoveryService.test.ts` | A broken collector cannot fail a scan; cross-source claims survive dedupe |

The HTML-parsing suite in `couponExtractor.test.ts` skips itself with a clear
reason if `cheerio` is not installed, so `npm test` is still meaningful before a
full `npm install`.

CI (`.github/workflows/ci.yml`) type-checks and tests on Node 20 and 22, builds
the Docker image (proving Chromium provisioning works) and validates
`docker-compose.yml`.

## Licence

MIT. Use the discovered information responsibly and in line with SHEIN's and each source's terms.
