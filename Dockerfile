FROM node:20-bookworm-slim

WORKDIR /app

# A source image has no .git directory (see .dockerignore), so pass immutable
# release provenance at build time. scripts/deploy-fly.js supplies these for
# every Fly release; a local Docker build can omit them safely.
ARG OXY_COMMIT_SHA
ARG OXY_GIT_BRANCH
ARG OXY_BUILD_TIME

COPY package*.json ./
RUN npm ci --omit=dev

# run_browser_task drives a real headless Chromium (playwright-extra). The slim base
# ships neither the browser binary nor its shared libs, so install both here or
# chromium.launch() fails at runtime in the slim Fly.io image without these libraries.
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV OXY_COMMIT_SHA=${OXY_COMMIT_SHA}
ENV OXY_GIT_BRANCH=${OXY_GIT_BRANCH}
ENV OXY_BUILD_TIME=${OXY_BUILD_TIME}
# Run the process in the app's canonical timezone so Date math (setHours/getHours
# in parseDirectionTime etc.) matches the user's clock. Without this Fly.io
# runs in UTC and "arrive by 9am" is parsed an hour off during BST.
ENV TZ=Europe/London

EXPOSE 8080

CMD ["npm", "start"]
