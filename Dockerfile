FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Uber Eats connector drives a real browser via Playwright (bundled with the
# @striderlabs/mcp-ubereats server). Install Chromium + its system libraries
# into the image so it exists on Cloud Run, where there is no host browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
# Per-user Uber Eats session scratch dir (durable copy lives in Supabase).
ENV UBEREATS_SESSIONS_DIR=/tmp/ubereats-sessions
# Run the process in the app's canonical timezone so Date math (setHours/getHours
# in parseDirectionTime etc.) matches the user's clock. Without this Cloud Run
# runs in UTC and "arrive by 9am" is parsed an hour off during BST.
ENV TZ=Europe/London

EXPOSE 8080

CMD ["npm", "start"]
