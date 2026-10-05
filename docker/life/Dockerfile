# Автопрогрев life.js. Код в образ не копируется: репозиторий монтируется в /app (docker-compose.yml).
# В образе только Node и зависимость patchright; браузер сюда не нужен, life.js подключается к
# запущенному Brave по CDP.
FROM node:24-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/opt/deps/node_modules

WORKDIR /opt/deps
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && mkdir /data && chown node:node /data

WORKDIR /app
USER node
CMD ["node", "life.js", "run", "--data", "/data"]
