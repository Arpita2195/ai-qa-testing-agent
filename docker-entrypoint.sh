#!/bin/sh
set -e

# Run database migrations if RUN_MIGRATIONS is true or not explicitly disabled
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Checking database connection and running pending migrations..."
  
  MAX_RETRIES=20
  COUNT=0
  SUCCESS=0

  while [ $COUNT -lt $MAX_RETRIES ]; do
    COUNT=$((COUNT + 1))
    if [ -f "dist/utils/migrate.js" ]; then
      if node dist/utils/migrate.js; then
        SUCCESS=1
        break
      fi
    else
      if npx tsx src/utils/migrate.ts; then
        SUCCESS=1
        break
      fi
    fi
    echo "[entrypoint] Migration attempt $COUNT/$MAX_RETRIES failed. Waiting 2s for database..."
    sleep 2
  done

  if [ $SUCCESS -ne 1 ]; then
    echo "[entrypoint] Error: Database migration failed after $MAX_RETRIES attempts."
    exit 1
  fi

  echo "[entrypoint] Database migrations applied successfully."
fi

# Execute the container command (e.g. node dist/server.js)
exec "$@"
