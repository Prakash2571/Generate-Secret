# =============================================================================
# Stage 1 - build TypeScript -> dist/
# =============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install every dependency (including devDependencies) for the build.
COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# =============================================================================
# Stage 2 - runtime with Chromium for Playwright
# =============================================================================
FROM node:22-bookworm-slim AS runtime

# Browsers live outside the home directory so a non-root user can read them.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=Asia/Kolkata

WORKDIR /app

# Production dependencies only.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Chromium + all OS libraries Playwright needs. Installing through the
# Playwright CLI guarantees the browser build matches the installed
# Playwright version, so there is no image-tag/npm-version mismatch.
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# Compiled application.
COPY --from=builder /app/dist ./dist

# Reports directory (usually bind-mounted from the host).
RUN mkdir -p /app/results && chown -R node:node /app/results

USER node

STOPSIGNAL SIGTERM

# Run node directly (never through npm) so SIGINT/SIGTERM reach the process
# and the graceful-shutdown handler can produce the final report.
CMD ["node", "dist/index.js"]
