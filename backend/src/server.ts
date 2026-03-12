import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { startAiDebounceJob } from './jobs/aiDebounce.job';
import { setAiServicePrisma } from './services/ai.service';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

  // Test DB connection
  try {
    await prisma.$connect();
    console.log('[Server] Database connected');
  } catch (err) {
    console.error('[Server] Database connection failed:', err);
    process.exit(1);
  }

  // Initialize AI service with DB reference for persistent logging
  setAiServicePrisma(prisma);

  const app = createApp(prisma);

  // Start background job
  const jobTimer = startAiDebounceJob(prisma);

  const server = app.listen(PORT, () => {
    console.log(`[Server] GuestPilot backend running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    clearInterval(jobTimer);
    server.close(async () => {
      await prisma.$disconnect();
      console.log('[Server] Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
