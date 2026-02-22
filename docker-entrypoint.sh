#!/bin/sh
# Seed default config files into volumes if they don't exist
if [ ! -f /app/config/company.json ] && [ -f /app/config-defaults/company.json ]; then
  echo "Seeding default company.json into config volume..."
  cp /app/config-defaults/company.json /app/config/company.json
fi

# Seed empty users.json if it doesn't exist (first-run setup via UI)
if [ ! -f /app/config/users.json ]; then
  echo "Seeding empty users.json into config volume..."
  echo '{"users":[]}' > /app/config/users.json
fi

exec "$@"
