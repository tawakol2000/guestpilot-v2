FROM node:18-slim

# Install Python 3 with minimal dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Python ML packages (--break-system-packages needed for Debian 12/PEP 668)
RUN pip3 install --no-cache-dir --break-system-packages scikit-learn numpy cohere

WORKDIR /app

# Copy files (context is backend/ directory)
COPY package*.json ./
COPY prisma ./prisma/
COPY src ./src/
COPY scripts ./scripts/
COPY config ./config/
COPY tsconfig.json ./

# Install Xvfb (virtual display) for headed Chrome mode + Chrome system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       xvfb xauth dbus-x11 fonts-liberation fonts-noto-color-emoji \
       libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
       libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
       libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node packages
RUN npm install

# Install full Google Chrome (rebrowser-playwright uses this in headed mode via Xvfb)
RUN npx playwright install chrome --with-deps

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript (increase heap for tsc on constrained containers)
RUN NODE_OPTIONS=--max-old-space-size=2048 npm run build

EXPOSE 3000
# xvfb-run provides a virtual display for headed Chrome (Turnstile bypass)
# Runtime heap: 1GB (Prisma + Socket.IO + BullMQ + Redis need ~500MB baseline)
CMD ["sh", "-c", "echo '[Deploy] Starting server...' && xvfb-run --auto-servernum --server-args='-screen 0 1280x720x24' node --max-old-space-size=1024 dist/server.js"]
