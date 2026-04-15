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
COPY .npmrc ./
COPY prisma ./prisma/
COPY src ./src/
COPY scripts ./scripts/
COPY config ./config/
COPY tsconfig.json ./

# Install Node packages (.npmrc sets legacy-peer-deps=true for the zod v3/v4
# split introduced by @anthropic-ai/claude-agent-sdk; flag passed explicitly
# here too so a stale image without .npmrc still resolves cleanly).
RUN npm install --legacy-peer-deps

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript (increase heap for tsc on constrained containers)
RUN NODE_OPTIONS=--max-old-space-size=2048 npm run build

EXPOSE 3000
# Runtime heap: 1GB (Prisma + Socket.IO + BullMQ + Redis need ~500MB baseline)
CMD ["sh", "-c", "echo '[Deploy] Starting server...' && NODE_OPTIONS=--max-old-space-size=1024 node dist/server.js"]
