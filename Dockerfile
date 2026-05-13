FROM node:20-alpine

LABEL org.opencontainers.image.title="windbu"
LABEL org.opencontainers.image.description="Local gateway for Windsurf AI — one OpenAI/Anthropic endpoint over multiple accounts"
LABEL org.opencontainers.image.source="https://github.com/defomok-max/windroute"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy only what the runtime actually needs. package.json lives here, no
# node_modules step — windbu is zero-dependency.
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY .env.example ./
COPY README.md CREDITS.md LICENSE ./

# Data dir for the container user — /data is mounted as a volume so the pool,
# stats, and logs survive container restarts.
ENV WINDBU_DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=20129
ENV WINDBU_NO_BROWSER=1

RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 20129

VOLUME ["/data"]

# Docker users usually supply LS_BINARY_PATH themselves (the Linux LS binary
# can't be redistributed in this image). The gateway boots with dashboard +
# /auth/login working even without LS; chat requires LS_BINARY_PATH set.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "bin/windbu.mjs"]
