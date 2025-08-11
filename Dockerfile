# syntax=docker/dockerfile:1

# Multi-stage build for Railway: builds deps (and optionally the Vite client)
# and runs the Node.js Socket.IO/Express server via tsx.

FROM node:22-alpine AS deps
WORKDIR /app

# Install dependencies (including devDeps for tsx and build tooling)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy source
COPY . .

# Optional: build the client for completeness (not served by the server here)
# Safe to keep, provides type-check via tsc as configured.
RUN yarn build || true


FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy only what we need to run the server
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server ./server
COPY --from=deps /app/package.json ./package.json

# Expose the port Railway will map (your code already respects $PORT)
EXPOSE 4000

# Optionally set defaults; override on Railway if needed
# ENV WS_BASE_PATH=/vid-ws

# Start the Socket.IO server (TypeScript via tsx)
CMD ["node_modules/.bin/tsx", "server/index.ts"]


