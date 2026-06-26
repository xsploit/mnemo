# riko-mind — a persistent gateway bot. Runs anywhere that keeps a process alive
# (your PC, Railway, Fly, a VPS). NOT serverless: Discord gateway bots need a
# long-lived WebSocket connection.
FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN npm install --no-audit --no-fund && npm run build

CMD ["node", "--enable-source-maps", "dist/index.js"]
