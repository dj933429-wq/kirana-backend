# ==============================================================================
# Stage 1: Build & Compile TypeScript
# ==============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json tsconfig.json prisma.config.ts* ./
COPY prisma/ ./prisma/

RUN npm ci

# Copy source files
COPY src/ ./src/

# Generate Prisma Client to src/generated/prisma before TypeScript compilation
RUN DIRECT_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" npx prisma generate

# Compile TypeScript to dist/
RUN npm run build


# Remove development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Runtime
# ==============================================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy production dependencies, compiled artifacts, and certificates
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY certs/ ./certs/

# Trust Supabase Root CA for strict SSL/TLS verification
ENV NODE_EXTRA_CA_CERTS=/app/certs/supabase-root.crt

# Hosting platform provides PORT; 8080 is used for local container testing
EXPOSE 8080

# Production container entrypoint
CMD ["node", "dist/server.js"]
