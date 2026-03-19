FROM node:18-slim

# Install Python 3 with minimal dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Python ML packages
RUN pip3 install --no-cache-dir scikit-learn numpy cohere

WORKDIR /app

# Copy backend files
COPY backend/package*.json ./
COPY backend/prisma ./prisma/
COPY backend/src ./src/
COPY backend/tsconfig.json ./

# Install Node packages
RUN npm install

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/server.js"]
