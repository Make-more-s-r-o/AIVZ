# Stage 1: Build React frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json* apps/web/
COPY package.json package-lock.json* ./
RUN npm ci --workspace=apps/web 2>/dev/null || (cd apps/web && npm ci)
COPY apps/web/ apps/web/
RUN cd apps/web && npm run build

# Stage 2: Build scripts (API server)
FROM node:22-alpine AS api-build
WORKDIR /app
COPY scripts/package.json scripts/package-lock.json* scripts/
COPY package.json package-lock.json* ./
RUN npm ci --workspace=scripts 2>/dev/null || (cd scripts && npm ci)
COPY scripts/ scripts/

# Stage 3: Production runtime
FROM node:22-alpine AS runtime
WORKDIR /app

# Copy built frontend
COPY --from=frontend-build /app/apps/web/dist apps/web/dist

# Copy API server with dependencies
COPY --from=api-build /app/scripts scripts
COPY --from=api-build /app/node_modules node_modules
COPY --from=api-build /app/package.json package.json

# Create data directories
RUN mkdir -p input output config config-defaults

# Copy default company config to a non-volume path (volumes override /app/config)
COPY config/ config-defaults/

# Entrypoint seeds defaults into volumes on first run
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3001

ENV NODE_ENV=production
ENV API_PORT=3001

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "scripts/src/serve-api.ts"]
