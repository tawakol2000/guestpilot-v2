import 'dotenv/config';
import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { startAiDebounceJob } from './jobs/aiDebounce.job';
import { startMessageSyncJob } from './jobs/messageSync.job';
import { setAiServicePrisma } from './services/ai.service';
import { initSocketIO } from './services/socket.service';
import { startAiReplyWorker } from './workers/aiReply.worker';
import { closeQueue } from './services/queue.service';
import { flushObservability } from './services/observability.service';
import { setPropertySearchPrisma } from './services/property-search.service';
import { startFaqMaintenanceJob } from './jobs/faqMaintenance.job';
import { startReservationSyncJob } from './jobs/reservationSync.job';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[FATAL] DATABASE_URL not set');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET not set');
    process.exit(1);
  }

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
  setPropertySearchPrisma(prisma);

  const app = createApp(prisma);
  const httpServer = createServer(app);

  // Attach Socket.IO to the HTTP server
  initSocketIO(httpServer);

  // Start background jobs
  const jobTimer = startAiDebounceJob(prisma);
  const syncJobTimer = startMessageSyncJob(prisma);

  // Start reservation sync job (polls Hostaway for new/updated reservations every 2 min)
  const resSyncTimer = startReservationSyncJob(prisma);

  // Start FAQ maintenance job (daily staleness + suggestion expiry)
  const faqJobTimer = startFaqMaintenanceJob(prisma);

  // Start BullMQ worker (graceful no-op if REDIS_URL missing)
  const aiReplyWorker = startAiReplyWorker(prisma);

  httpServer.listen(PORT, () => {
    console.log(`[Server] GuestPilot backend running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    clearInterval(jobTimer);
    clearInterval(syncJobTimer);
    clearInterval(resSyncTimer);
    clearInterval(faqJobTimer);
    if (aiReplyWorker) await aiReplyWorker.close();
    await closeQueue();
    await flushObservability();
    httpServer.close(async () => {
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
