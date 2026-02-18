#!/bin/sh
# Seed default config files into volumes if they don't exist
if [ ! -f /app/config/company.json ] && [ -f /app/config-defaults/company.json ]; then
  echo "Seeding default company.json into config volume..."
  cp /app/config-defaults/company.json /app/config/company.json
fi

exec "$@"
