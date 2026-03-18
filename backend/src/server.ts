import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { startAiDebounceJob } from './jobs/aiDebounce.job';
import { setAiServicePrisma } from './services/ai.service';
import { startAiReplyWorker } from './workers/aiReply.worker';
import { closeQueue } from './services/queue.service';
import { flushObservability } from './services/observability.service';
import { seedTenantSops, ingestPropertyKnowledge } from './services/rag.service';
import { initializeClassifier, setClassifierThresholds } from './services/classifier.service';
import { setEmbeddingProvider, type EmbeddingProvider } from './services/embeddings.service';

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

  // Start background jobs
  const jobTimer = startAiDebounceJob(prisma);

  // Start BullMQ worker (graceful no-op if REDIS_URL missing)
  const aiReplyWorker = startAiReplyWorker(prisma);

  const server = app.listen(PORT, () => {
    console.log(`[Server] GuestPilot backend running on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Background: re-embed all RAG chunks on startup (ensures embeddings match current model)
  (async () => {
    try {
      const tenants = await prisma.tenant.findMany({ select: { id: true } });
      for (const tenant of tenants) {
        // Re-seed SOP chunks with fresh embeddings
        const sopCount = await seedTenantSops(tenant.id, prisma);
        console.log(`[Startup] Re-embedded ${sopCount} SOP chunks for tenant ${tenant.id}`);

        // Re-embed property chunks
        const properties = await prisma.property.findMany({ where: { tenantId: tenant.id } });
        for (const prop of properties) {
          await ingestPropertyKnowledge(tenant.id, prop.id, prop, prisma);
        }
        console.log(`[Startup] Re-embedded ${properties.length} property chunk sets for tenant ${tenant.id}`);
      }

      // Initialize the KNN classifier for SOP routing
      try {
        await initializeClassifier();
        // Load Tier 1 thresholds from DB (first tenant — single-tenant system)
        if (tenants.length > 0) {
          const cfg = await prisma.tenantAiConfig.findUnique({
            where: { tenantId: tenants[0].id },
            select: { classifierVoteThreshold: true, classifierContextualGate: true, embeddingProvider: true },
          });
          if (cfg) {
            setClassifierThresholds(cfg.classifierVoteThreshold, cfg.classifierContextualGate);
            if (cfg.embeddingProvider) setEmbeddingProvider(cfg.embeddingProvider as EmbeddingProvider);
          }
        }
        console.log('[Startup] KNN classifier initialized');
      } catch (err) {
        console.warn('[Startup] KNN classifier init failed (non-fatal):', err);
      }
    } catch (err) {
      console.warn('[Startup] Background re-embed failed (non-fatal):', err);
    }
  })();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    clearInterval(jobTimer);
    if (aiReplyWorker) await aiReplyWorker.close();
    await closeQueue();
    await flushObservability();
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
