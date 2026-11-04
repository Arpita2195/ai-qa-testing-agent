FROM node:22-bookworm-slim

# Install system dependencies for Playwright Chromium, curl for health checks, and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure Playwright installs Chromium in a shared system path accessible to non-root user
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy package manifests first for optimal Docker layer caching
COPY package*.json ./

# Install all dependencies (including build tools)
RUN npm ci

# Install Playwright Chromium browser binary and its Linux system dependencies
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R 777 /ms-playwright

# Copy TypeScript configuration, source code, database migrations, and entrypoint script
COPY tsconfig.json ./
COPY src/ ./src/
COPY database/ ./database/
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Build TypeScript source code into dist/
RUN npm run build

# Ensure LF line endings on the entrypoint script and set executable permissions
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# Create artifacts directory and assign ownership to non-root 'node' user
RUN mkdir -p /app/artifacts && \
    chown -R node:node /app /ms-playwright

# Security: Run as non-root user
USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
