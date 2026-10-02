# --- build stage: compile native deps (better-sqlite3) and fetch the client-side QR decoders ---
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev \
 && mkdir -p /tmp/vendor \
 && cp node_modules/jsqr/dist/jsQR.js /tmp/vendor/jsQR.js \
 && cp node_modules/zxing-wasm/dist/iife/reader/index.js /tmp/vendor/zxing-reader.js \
 && cp node_modules/zxing-wasm/dist/reader/zxing_reader.wasm /tmp/vendor/zxing_reader.wasm

# --- runtime stage ---
FROM node:20-alpine
LABEL org.opencontainers.image.title="matterqr" \
      org.opencontainers.image.description="Scan, store and re-display Matter device pairing QR codes" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js gdrive.js ./
COPY public ./public
COPY --from=build /tmp/vendor/ ./public/vendor/

RUN mkdir -p /app/data/photos

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
