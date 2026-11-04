# Build Stage: Compile React + Vite TypeScript SPA
FROM node:22-bookworm-slim AS build

WORKDIR /workspace/dashboard

# Accept VITE_API_URL as a build-time argument (defaults to http://localhost:3000)
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}

# Copy dependency specifications first for Docker layer caching
COPY dashboard/package*.json ./
RUN npm ci

# Copy source code and build production bundle
COPY dashboard/ ./
COPY src/ ../src/
RUN npm run build

# Production Stage: Hardened, unprivileged non-root Nginx
FROM nginxinc/nginx-unprivileged:alpine-slim AS production

# Copy custom Nginx configuration supporting SPA routing
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf

# Copy production build artifacts from build stage
COPY --from=build /workspace/dashboard/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
