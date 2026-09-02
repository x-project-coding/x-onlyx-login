# Runs the end-to-end test: the real Electron app, under Xvfb, against the in-process fakes.
# Node 22 because electron 44's install and runtime need it (the host is on 18).
FROM node:22-bookworm

# Chromium's runtime libraries + a virtual display + openssl for the throwaway cert.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth openssl ca-certificates \
      libgtk-3-0 libnss3 libnspr4 libasound2 libgbm1 libxss1 libxtst6 \
      libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 \
      libcairo2 libatspi2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
# electron 44 has no postinstall; requiring it downloads the binary. Bake it into the image now.
RUN node -e "require('electron')" && test -f node_modules/electron/dist/electron
COPY . .

ENV ELECTRON_DISABLE_SANDBOX=1
CMD ["bash", "test/e2e/run.sh"]
