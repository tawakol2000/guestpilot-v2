FROM node:18-bullseye

# Install Python 3 and pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir scikit-learn numpy cohere

WORKDIR /app

# Copy entire backend directory
COPY backend/ ./

# Install Node dependencies
RUN npm ci

# Build
RUN npx prisma generate && npm run build

# Start
EXPOSE 3000
CMD ["npm", "run", "start"]
