FROM node:24-bookworm-slim

# Server only: this image has no desktop. Bots keep the headless browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-dejavu-core fonts-noto-core tini ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/stellarcortex
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev \
    && node node_modules/@openai/codex/bin/codex.js --version \
    && npx playwright install-deps chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/stellarcortex-browsers
RUN npx playwright install chromium \
    && mkdir -p /data /home/node/.codex /home/node/.claude \
    && chown -R node:node /data /home/node/.codex /home/node/.claude /opt/stellarcortex-browsers
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs ./docs
COPY --chown=node:node README.md README.he.md LICENSE ./
USER node
ENV HOME=/home/node STELLARCORTEX_DATA_DIR=/data CODEX_HOME=/home/node/.codex CLAUDE_CONFIG_DIR=/home/node/.claude \
    PORT=4317
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--","node","src/server.mjs"]
