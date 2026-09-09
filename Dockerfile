# AudioShelf — one small image, no native builds (SQLite ships inside Node 22).
FROM node:22-alpine

ENV NODE_ENV=production \
    AUDIOSHELF_LIBRARY=/library \
    AUDIOSHELF_DATA=/data \
    AUDIOSHELF_HOST=0.0.0.0

# ffmpeg powers the Audible (.aax/.aaxc) import; su-exec drops privileges after
# the entrypoint has fixed ownership on mounted volumes.
RUN apk add --no-cache ffmpeg su-exec

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web
COPY scripts ./scripts

RUN mkdir -p /data /library && chown -R node:node /app /data

VOLUME ["/data", "/library"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${AUDIOSHELF_PORT:-8080}/api/health" || exit 1

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
