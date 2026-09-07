# Runtime for both services.
#
# The worker needs a real browser: HLTV returns 403 to any plain HTTP client
# but serves Chromium normally, and that is the only way CS2 results are
# reachable. Nixpacks won't install the browser's system libraries, so the
# image is built from Playwright's own, which already has them.
#
# The dashboard is built from the same image. It doesn't need the browser, but
# one image for one repo is worth more than the megabytes saved by two.
# Tag must match the playwright version in package.json — the image ships the
# browser build that version expects, and a mismatch fails at launch.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production
# Playwright's image ships browsers here; without this the runtime looks in a
# per-user cache that doesn't exist for the container's user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Dependencies first, so a code change doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SERVICE_ROLE picks worker or web at runtime; see src/main.ts.
CMD ["npm", "start"]
