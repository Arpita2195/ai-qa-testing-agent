# Docker Containerization & Production Deployment Guide

This guide details the containerization architecture, configuration, security hardening, and operational commands for the **AI QA Testing Agent** platform.

---

## 1. Architecture Overview

The system is containerized as three orchestrated services connected over an isolated Docker bridge network (`ai_qa_network`):

```
                                  +---------------------------------------+
                                  |            Host Browser               |
                                  +---------------------------------------+
                                        |                           |
                            HTTP :5173  |               HTTP :3000  |
                                        v                           v
                        +-----------------------+   +-------------------------------+
                        |      Dashboard        |   |         Backend API           |
                        | (nginx-unprivileged)  |   |    (Node.js 22 + Chromium)   |
                        |      Port: 8080       |   |          Port: 3000           |
                        +-----------------------+   +-------------------------------+
                                    |                               |
                                    | Internal Docker Network       | postgresql://postgres@postgres:5432
                                    | (ai_qa_network)               v
                                    |                   +-----------------------+
                                    +------------------>|      PostgreSQL       |
                                                        |      (postgres:16)    |
                                                        |     Port: 5432 (int)  |
                                                        +-----------------------+
                                                                    |
                                                            [Persistent Volume:
                                                             postgres_data]
```

### Services Summary

| Service | Base Image | Internal Port | Host Port | Non-Root User | Healthcheck |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **postgres** | `postgres:16-alpine` | `5432` | *(None - internal only)* | `postgres` (UID 70) | `pg_isready -U postgres -d ai_qa_agent` |
| **backend** | `node:22-bookworm-slim` | `3000` | `3000:3000` | `node` (UID 1000) | `curl -f http://localhost:3000/health` |
| **dashboard** | `nginxinc/nginx-unprivileged:alpine-slim` | `8080` | `5173:8080` | `nginx` (UID 101) | `wget -q -O /dev/null http://localhost:8080/` |

---

## 2. Security Hardening & Best Practices

1. **Non-Root Execution**:
   - The backend runs as the built-in non-root `node` user (UID 1000).
   - The dashboard runs using `nginxinc/nginx-unprivileged:alpine-slim` as the unprivileged `nginx` user (UID 101) listening on port `8080`.
2. **Least Privilege & Linux Capabilities**:
   - `cap_drop: [ALL]` applied to backend and dashboard containers.
   - Only strictly required capabilities (`CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`) granted to `postgres` for startup initialization.
   - `security_opt: [no-new-privileges:true]` enforced on all services to prevent privilege escalation.
3. **Read-Only Root Filesystem & Tmpfs Mounts**:
   - The dashboard container runs with `read_only: true`. Temporary write locations (`/tmp`, `/var/run`, `/var/cache/nginx`) are mounted as isolated in-memory `tmpfs` mounts with `noexec` and `nosuid` flags.
   - Backend and PostgreSQL use isolated `tmpfs` mounts for `/tmp`.
4. **Resource Constraints & Denial-of-Service Defense**:
   - Hard CPU and memory limits are configured on all containers in `docker-compose.yml` (e.g., Backend: 2 CPU / 2GB RAM; Postgres: 1 CPU / 512MB RAM; Dashboard: 0.5 CPU / 128MB RAM) to prevent noisy neighbor and resource exhaustion attacks.
   - Request body limit capped at 10MB in both Fastify (`bodyLimit: 10 * 1024 * 1024`) and Nginx (`client_max_body_size 10M`).
5. **Database Isolation**:
   - The PostgreSQL container exposes **NO host ports by default**. Only services on the internal Docker bridge network (`ai_qa_network`) can communicate with PostgreSQL on port `5432`.
6. **Playwright Chromium Browser Isolation**:
   - Headless Chromium runs inside the backend container with container-safe flags (`--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`) and `shm_size: 1gb`.
   - Browser navigation is strictly monitored by `urlGuard` and `attachUrlGuardToPage`. Outbound requests and redirects to internal container names (`postgres`, `backend`, `dashboard`, `database`), `.docker.internal`, private IPv4/IPv6 CIDRs, and cloud metadata endpoints (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`) are blocked unconditionally.
7. **Session Security & Signed Cookies**:
   - Session cookies (`qa_session`) are signed using HMAC-SHA256 with `COOKIE_SECRET`, preventing client-side tampering.
   - Cookies are marked `HttpOnly: true`, `SameSite: Lax`, and `Secure: true` in production environments.
   - Password changes and admin role modifications immediately invalidate all active sessions (`revokeUserSessions`) to close stale privilege access windows.
   - CSRF tokens are cryptographically generated and enforced on state-changing HTTP requests.
8. **HTTP Security Headers & CORS**:
   - Both Nginx and Fastify emit strict defense-in-depth security headers:
     - `Content-Security-Policy`: Restricts scripts, objects, and framing.
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY` (backend) / `SAMEORIGIN` (dashboard)
     - `Referrer-Policy: strict-origin-when-cross-origin`
     - `Strict-Transport-Security: max-age=31536000; includeSubDomains` (production)
     - `Permissions-Policy`: Disables unused browser hardware capabilities.
   - CORS is restricted to explicit trusted origins via `CORS_ORIGIN` in production.
9. **Persistent Storage**:
   - PostgreSQL data: `postgres_data` volume (`/var/lib/postgresql/data`).
   - Screenshots, traces, and evidence: `test_artifacts` volume (`/app/artifacts`).

---

## 3. Environment Variables Configuration

Copy `.env.example` to `.env` before running Docker Compose:

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Description | Production Requirement / Generation |
| :--- | :--- | :--- |
| `COOKIE_SECRET` | Secret key used to sign HTTP session cookies | **Required in production** (min 32 chars). Generate with `openssl rand -hex 32` |
| `PLATFORM_API_KEY` | CI/CD automation & platform service key | **Required in production** (min 32 chars). Generate with `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | AES-256 base64 32-byte secret key for credential store | **Required in production**. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `POSTGRES_USER` | PostgreSQL superuser | Set non-default username (e.g., `qa_admin`) |
| `POSTGRES_PASSWORD` | PostgreSQL password | Set strong, high-entropy password |
| `POSTGRES_DB` | PostgreSQL database name | `ai_qa_agent` |
| `DATABASE_URL` | Database connection URL | `postgresql://<user>:<pass>@postgres:5432/ai_qa_agent` |
| `GEMINI_API_KEY` | Google Gemini API key for AI generation | Valid Google AI Studio API key |
| `AI_MODEL` | Gemini model variant | `gemini-2.5-flash` or `gemini-1.5-pro` |
| `ALLOW_PRIVATE_TARGETS` | Permit private network target URLs | **Must be `false` in production** |
| `CORS_ORIGIN` | Allowed web origins | Set to explicit production URL(s) (e.g., `https://qa.example.com`) |
| `VITE_API_URL` | API endpoint accessed by browser | `https://api.qa.example.com` or `/api` behind reverse proxy |
| `COOKIE_SECURE` | Force secure cookies over HTTPS | `true` |
| `NODE_ENV` | Environment identifier | `production` |
| `DASHBOARD_PORT` | Host port for dashboard | `5173` |
| `BACKEND_PORT` | Host port for backend API | `3000` |
| `RUN_MIGRATIONS` | Auto-apply migrations on startup | `true` |

---

## 4. Operational Commands Reference

### Validating Configuration
Check the resolved compose file and environment substitutions:
```bash
docker compose config
```

### Building Images
Build or rebuild all container images without starting:
```bash
docker compose build
```
To force a clean rebuild without using layer cache:
```bash
docker compose build --no-cache
```

### Starting the Application
Start all services in detached background mode:
```bash
docker compose up -d
```
The startup flow enforces ordering:
1. `postgres` starts and initializes its data directory.
2. `postgres` passes health check via `pg_isready`.
3. `backend` starts, connects to PostgreSQL, applies pending migrations, and binds to `:3000`.
4. `backend` passes health check via `GET /health`.
5. `dashboard` starts Nginx and serves compiled SPA assets on `:5173`.

### Stopping Services
Stop running containers without removing volumes:
```bash
docker compose down
```
To stop containers AND remove named volumes (WARNING: wipes database and artifacts):
```bash
docker compose down -v
```

### Restarting Services
Restart all services:
```bash
docker compose restart
```
Restart a specific service:
```bash
docker compose restart backend
```

### Checking Status and Health
Inspect status and health check state of all services:
```bash
docker compose ps
```

### Viewing Logs
Stream logs for all services:
```bash
docker compose logs -f
```
Stream logs for a specific container:
```bash
docker compose logs -f backend
docker compose logs -f dashboard
docker compose logs -f postgres
```

### Executing Migrations Manually
Run database migrations on demand inside a one-off backend container:
```bash
docker compose run --rm backend node dist/utils/migrate.js
```

### Running Tests in Container
Execute test suite inside the container environment:
```bash
docker compose run --rm backend npm test
```

---

## 5. Accessing the Application

- **Dashboard UI**: [http://localhost:5173](http://localhost:5173)
- **Backend API**: [http://localhost:3000](http://localhost:3000)
- **Health Check Endpoint**: [http://localhost:3000/health](http://localhost:3000/health)
- **Interactive API Documentation / Swagger**: Accessible via defined Fastify routes.

---

## 6. Troubleshooting

1. **Port Collisions (`address already in use`)**:
   If local dev servers (`npm run dev`) or local PostgreSQL are already bound to host ports:
   - Terminate local dev instances, OR
   - Override host ports in `.env`: `BACKEND_PORT=3001` and `DASHBOARD_PORT=5174`.
2. **Database Connection Failures**:
   Ensure `ai_qa_postgres` container is healthy:
   ```bash
   docker compose ps postgres
   docker compose logs postgres
   ```
3. **Playwright Browser Issues**:
   Playwright Chromium is installed in `/ms-playwright` inside the container. Ensure `shm_size: 1gb` is maintained in `docker-compose.yml`.

---

## 7. Backup and Disaster Recovery

### Automated Database Backups (`pg_dump`)
Run a compressed logical backup of the PostgreSQL database without downtime:
```bash
# Timestamped SQL dump
docker compose exec -T postgres pg_dump -U postgres -d ai_qa_agent --clean --if-exists > backup_$(date +%Y%m%d_%H%M%S).sql

# Custom archive format (compressed, recommended for large databases)
docker compose exec -T postgres pg_dump -U postgres -d ai_qa_agent -Fc > backup_$(date +%Y%m%d_%H%M%S).dump
```

### Database Restoration (`pg_restore`)
Restore a database from a dump:
```bash
# Restore from plain SQL file
docker compose exec -T postgres psql -U postgres -d ai_qa_agent < backup.sql

# Restore from custom archive format
docker compose exec -T postgres pg_restore -U postgres -d ai_qa_agent -c backup.dump
```

### Artifact Volume Backup
Test artifacts (screenshots, traces, failure diffs) stored in the `test_artifacts` named volume can be archived to a tarball:
```bash
docker run --rm -v ai_qa_test_artifacts:/artifacts -v $(pwd):/backup alpine tar czf /backup/artifacts_backup_$(date +%Y%m%d).tar.gz -C /artifacts .
```

To restore artifacts:
```bash
docker run --rm -v ai_qa_test_artifacts:/artifacts -v $(pwd):/backup alpine sh -c "rm -rf /artifacts/* && tar xzf /backup/artifacts_backup.tar.gz -C /artifacts"
```

---

## 8. Production Deployment Checklist

Before exposing the application to real production traffic:

- [ ] **Strong Secrets Set**:
  - `COOKIE_SECRET` is set to a cryptographically random 32+ character string (not default dev value).
  - `PLATFORM_API_KEY` is regenerated and stored in deployment secret manager.
  - `ENCRYPTION_KEY` is a distinct base64-encoded 32-byte AES key.
  - `POSTGRES_PASSWORD` is unique and high-entropy.
- [ ] **SSRF & Target Security**:
  - `ALLOW_PRIVATE_TARGETS` is explicitly set to `false`.
  - Target URL validation actively rejects RFC 1918 private IPs, loopback, link-local, and cloud metadata (`169.254.169.254`).
- [ ] **Network & Port Exposure**:
  - PostgreSQL port `5432` has NO port mapping on the host (internal network only).
  - Only reverse proxy port (443 / 80) and API gateway are exposed.
- [ ] **HTTPS / TLS Configuration**:
  - TLS termination enabled (via Nginx, Cloudflare, AWS ALB, or Traefik).
  - Certificates installed and auto-renewing (Let's Encrypt / Certbot).
  - `Strict-Transport-Security` header verified.
  - `COOKIE_SECURE=true` enabled so session cookies require HTTPS.
- [ ] **CORS Configuration**:
  - `CORS_ORIGIN` matches exact production frontend domain(s) (no wildcards `*`).
- [ ] **Container Capabilities & Isolation**:
  - `cap_drop: [ALL]` applied to application containers.
  - `no-new-privileges:true` active.
  - Dashboard running with `read_only: true`.
  - CPU and memory resource limits enforced on all containers.
- [ ] **Database & Migrations**:
  - Automated backups scheduled via cron or cloud snapshot.
  - All migrations applied cleanly (`RUN_MIGRATIONS=true`).
- [ ] **Artifact Storage**:
  - Persistent volume `test_artifacts` monitored for storage capacity or mounted to cloud-backed block storage.

---

## 9. Remaining Security Limitations & Roadmap

While Task 11 applies defense-in-depth hardening to the current architecture, the following inherent architectural limitations remain and should be addressed in subsequent milestones:

1. **Chromium `--no-sandbox` inside Container**:
   - Because Chromium is executed within a container lacking Linux user namespaces or kernel SUID sandbox helpers, `--no-sandbox` is required.
   - *Mitigation applied*: We drop all container capabilities (`cap_drop: [ALL]`), enforce `no-new-privileges`, run as non-root `node` (UID 1000), apply memory/CPU limits, and actively filter all network requests and redirects via `urlGuard` before navigation.
   - *Future improvement*: Move browser execution into dedicated ephemeral sandbox worker pools (e.g., gVisor / microVMs / Browserless sandbox pods) isolated from backend application code.
2. **Absence of Distributed Cache / Rate Limiting (Redis)**:
   - In-memory rate limiting (`loginRateLimitMap`) is currently process-local. If horizontal scaling across multiple backend replicas is introduced in the future, rate limiting must be backed by a centralized store (e.g., Redis). Redis was explicitly excluded from Task 11 by requirement.
3. **Single-Node PostgreSQL**:
   - Database runs as a single-instance container with persistent volume storage. High-availability read replicas, automated failover, and continuous WAL archiving to object storage (e.g., pgBackRest / AWS RDS) are recommended for enterprise cloud deployments.
4. **Secret Management in File / Environment Variables**:
   - Secrets are currently supplied via environment variables (`.env`). In enterprise cloud environments, credentials should be injected at runtime using dedicated secret vaults (e.g., HashiCorp Vault, AWS Secrets Manager, or Kubernetes Secrets).

