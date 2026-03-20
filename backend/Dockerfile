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

# Install Node packages
RUN npm install

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/server.js"]
