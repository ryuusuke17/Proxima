# Proxima (Fork with DeepSeek) - Dockerized Electron + REST API + VNC
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=18

# Install system deps: Electron, xvfb, VNC, fluxbox, Node
RUN apt-get update && apt-get install -y \
    curl \
    git \
    wget \
    xvfb \
    x11vnc \
    fluxbox \
    xdotool \
    wmctrl \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libexpat1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxkbcommon0 \
    libgtk-3-0 \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18 from nodesource
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version

# Create app directory
WORKDIR /app

# Copy the forked Proxima source (excluding node_modules)
COPY package.json package-lock.json ./
COPY electron/ ./electron/
COPY src/ ./src/
COPY cli/ ./cli/
COPY sdk/ ./sdk/
COPY assets/ ./assets/

# Install npm dependencies
RUN npm install --omit=dev 2>&1 | tail -5

# Patch rest-api.cjs to bind 0.0.0.0 (required for Docker host access)
RUN sed -i "s/127.0.0.1/0.0.0.0/g" /app/electron/rest-api.cjs && \
    echo "Patched rest-api.cjs to bind 0.0.0.0"

# Pre-seed default settings with all providers enabled (including DeepSeek)
RUN mkdir -p /root/.config/proxima && \
    echo '{"providers":{"perplexity":{"enabled":true,"loggedIn":false},"chatgpt":{"enabled":true,"loggedIn":false},"claude":{"enabled":true,"loggedIn":false},"gemini":{"enabled":true,"loggedIn":false},"deepseek":{"enabled":true,"loggedIn":false}},"ipcPort":19222,"theme":"dark","headlessMode":true,"startMinimized":false,"restApiEnabled":true}' > /root/.config/proxima/settings.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3210 5900 19222

ENTRYPOINT ["/entrypoint.sh"]
