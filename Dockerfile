# ---
# Stage 1: Build the TypeScript application
# ---

# A portable solution: download image from Docker Hub.
# FROM node:25.8.0-alpine AS builder

# A less portable solution: download image through a cache proxy provided by the University.
# This solution is necessary to avoid "Too many requests" errors.
# This solution may not work outside of the University network.
FROM harbor.pg.innopolis.university/docker-hub-cache/node:25.8.0-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build
RUN CI=true pnpm prune --prod

# ---
# Stage 2: Production runtime
# ---

# A portable solution: download image from Docker Hub.
# FROM node:25.8.0-alpine

# A less portable solution: download image through a cache proxy provided by the University.
# This solution is necessary to avoid "Too many requests" errors.
# This solution may not work outside of the University network.
FROM harbor.pg.innopolis.university/docker-hub-cache/node:25.8.0-alpine

WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Create directory for qwen credentials
RUN mkdir -p /home/app/.qwen && chown -R app:app /app /home/app/.qwen

USER app

# Expose port
EXPOSE ${PORT:-8080}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-8080}/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "dist/index.js"]
