# AudioShelf — one small image, no native builds (SQLite ships inside Node 22).
FROM node:22-alpine

ENV NODE_ENV=production \
    AUDIOSHELF_LIBRARY=/library \
    AUDIOSHELF_DATA=/data \
    AUDIOSHELF_HOST=0.0.0.0 \
    AUDIOSHELF_PORT=8080

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web
COPY scripts ./scripts

RUN mkdir -p /data /library && chown -R node:node /app /data
USER node

VOLUME ["/data", "/library"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
