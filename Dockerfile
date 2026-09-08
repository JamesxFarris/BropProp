# Runtime for both services.
#
# This used to be built FROM mcr.microsoft.com/playwright — about 2GB — because
# HLTV returns 403 to any plain HTTP client and only serves a real browser, and
# that was once the only route to CS2 results. It isn't any more. bo3.gg serves
# per-map, per-player stats over plain JSON, it covers strictly more (665 of 672
# maps against HLTV's 1 of 30), and nothing on any schedule launches a browser:
# the CS2 sweep in src/cron.ts calls fetchBo3, and grading reads bo3 too.
#
# So the browser and its system libraries came out. The image drops from ~2GB to
# a couple of hundred MB, which is worth more than the megabytes suggests: a 2GB
# image has to be pulled to the runtime host on every deploy, and a deploy that
# takes ten-plus minutes to initialise is a deploy you cannot tell apart from a
# stuck one.
#
# playwright moved to devDependencies alongside this, so `npm ci --omit=dev`
# leaves it out entirely. src/results/hltv.ts imports it dynamically and already
# fails with a clear message when it is absent — which is the correct outcome
# for a source that is kept for its history and is on no schedule.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a code change doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SERVICE_ROLE picks worker or web at runtime; see src/main.ts.
CMD ["npm", "start"]
