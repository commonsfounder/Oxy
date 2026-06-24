FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# run_browser_task drives a real headless Chromium (playwright-extra). The slim base
# ships neither the browser binary nor its shared libs, so install both here or
# chromium.launch() fails at runtime on Cloud Run. --with-deps pulls the apt libs.
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
# Run the process in the app's canonical timezone so Date math (setHours/getHours
# in parseDirectionTime etc.) matches the user's clock. Without this Cloud Run
# runs in UTC and "arrive by 9am" is parsed an hour off during BST.
ENV TZ=Europe/London

EXPOSE 8080

CMD ["npm", "start"]
