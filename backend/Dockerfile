FROM node:18-bullseye

# Install Python 3 and pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install scikit-learn numpy cohere

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma

# Install Node dependencies
RUN npm ci

# Copy source
COPY . .

# Build
RUN npx prisma generate && npm run build

# Start
EXPOSE 3000
CMD ["npm", "run", "start"]
