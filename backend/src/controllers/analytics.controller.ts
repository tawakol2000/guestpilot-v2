import { Response } from 'express';
import { PrismaClient, MessageRole } from '@prisma/client';
import { AuthenticatedRequest } from '../types';

export function makeAnalyticsController(prisma: PrismaClient) {
  return {
    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { tenantId } = req;
        const range = (req.query.range as string) || '30d';
        const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;

        const now = new Date();
        const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

        // Messages in period
        const messages = await prisma.message.findMany({
          where: { tenantId, sentAt: { gte: from } },
          select: { role: true, sentAt: true, conversationId: true },
          orderBy: { sentAt: 'asc' },
        });

        const messagesReceived = messages.filter(m => m.role === MessageRole.GUEST).length;
        const messagesSent = messages.filter(m => m.role !== MessageRole.GUEST).length;
        const aiMessagesSent = messages.filter(m => m.role === MessageRole.AI).length;

        // Tasks in period
        const tasks = await prisma.task.findMany({
          where: { tenantId, createdAt: { gte: from } },
          select: { status: true, urgency: true },
        });
        const tasksCreated = tasks.length;
        const tasksCompleted = tasks.filter(t => t.status === 'completed').length;

        // AI resolution rate: conversations where last message is AI (no HOST follow-up)
        const convIds = [...new Set(messages.map(m => m.conversationId))];
        let aiResolved = 0;
        for (const convId of convIds) {
          const convMsgs = messages.filter(m => m.conversationId === convId);
          const lastMsg = convMsgs[convMsgs.length - 1];
          if (lastMsg?.role === MessageRole.AI) aiResolved++;
        }
        const aiResolutionRate = convIds.length > 0 ? Math.round((aiResolved / convIds.length) * 100) : 0;

        // Avg response time: time from GUEST message to next AI/HOST message
        const guestMsgs = messages.filter(m => m.role === MessageRole.GUEST);
        const responseTimes: number[] = [];
        for (const gMsg of guestMsgs) {
          const nextReply = messages.find(m =>
            m.conversationId === gMsg.conversationId &&
            m.role !== MessageRole.GUEST &&
            m.sentAt > gMsg.sentAt
          );
          if (nextReply) {
            responseTimes.push(nextReply.sentAt.getTime() - gMsg.sentAt.getTime());
          }
        }
        const avgResponseTimeMs = responseTimes.length > 0
          ? Math.round(responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length / 2)])
          : 0;

        // By day
        const byDayMap: Record<string, { messagesReceived: number; messagesSent: number; aiMessagesSent: number }> = {};
        for (let d = 0; d < days; d++) {
          const date = new Date(from.getTime() + d * 24 * 60 * 60 * 1000);
          const key = date.toISOString().slice(0, 10);
          byDayMap[key] = { messagesReceived: 0, messagesSent: 0, aiMessagesSent: 0 };
        }
        for (const m of messages) {
          const key = m.sentAt.toISOString().slice(0, 10);
          if (!byDayMap[key]) byDayMap[key] = { messagesReceived: 0, messagesSent: 0, aiMessagesSent: 0 };
          if (m.role === MessageRole.GUEST) byDayMap[key].messagesReceived++;
          else byDayMap[key].messagesSent++;
          if (m.role === MessageRole.AI) byDayMap[key].aiMessagesSent++;
        }
        const byDay = Object.entries(byDayMap).map(([date, counts]) => ({ date, ...counts }));

        // By property
        const properties = await prisma.property.findMany({
          where: { tenantId },
          select: { id: true, name: true },
        });
        const convsByProp = await prisma.conversation.findMany({
          where: { tenantId, lastMessageAt: { gte: from } },
          select: { id: true, propertyId: true },
        });
        const byProperty = properties.map(p => {
          const propConvIds = new Set(convsByProp.filter(c => c.propertyId === p.id).map(c => c.id));
          const propMsgs = messages.filter(m => propConvIds.has(m.conversationId));
          return {
            propertyId: p.id,
            propertyName: p.name,
            conversations: propConvIds.size,
            aiMessages: propMsgs.filter(m => m.role === MessageRole.AI).length,
            hostMessages: propMsgs.filter(m => m.role === MessageRole.HOST).length,
          };
        });

        // Top urgencies
        const urgencyMap: Record<string, number> = {};
        for (const t of tasks) {
          urgencyMap[t.urgency] = (urgencyMap[t.urgency] || 0) + 1;
        }
        const topUrgencies = Object.entries(urgencyMap).map(([urgency, count]) => ({ urgency, count }));

        // A3: Response time distribution buckets
        const rtBuckets = { under5m: 0, under15m: 0, under1h: 0, under4h: 0, over4h: 0 };
        for (const rt of responseTimes) {
          if (rt < 5 * 60 * 1000) rtBuckets.under5m++;
          else if (rt < 15 * 60 * 1000) rtBuckets.under15m++;
          else if (rt < 60 * 60 * 1000) rtBuckets.under1h++;
          else if (rt < 4 * 60 * 60 * 1000) rtBuckets.under4h++;
          else rtBuckets.over4h++;
        }
        const rtTotal = responseTimes.length || 1;
        const responseTimeDistribution = {
          under5m: Math.round((rtBuckets.under5m / rtTotal) * 100),
          under15m: Math.round((rtBuckets.under15m / rtTotal) * 100),
          under1h: Math.round((rtBuckets.under1h / rtTotal) * 100),
          under4h: Math.round((rtBuckets.under4h / rtTotal) * 100),
          over4h: Math.round((rtBuckets.over4h / rtTotal) * 100),
        };

        // A4: Channel performance — messages by channel with avg response time
        const msgsByChannel = await prisma.message.findMany({
          where: { tenantId, sentAt: { gte: from } },
          select: { role: true, sentAt: true, conversationId: true, channel: true },
          orderBy: { sentAt: 'asc' },
        });
        const channelMap: Record<string, { received: number; sent: number; ai: number; responseTimes: number[] }> = {};
        for (const m of msgsByChannel) {
          const ch = m.channel || 'OTHER';
          if (!channelMap[ch]) channelMap[ch] = { received: 0, sent: 0, ai: 0, responseTimes: [] };
          if (m.role === MessageRole.GUEST) channelMap[ch].received++;
          else channelMap[ch].sent++;
          if (m.role === MessageRole.AI) channelMap[ch].ai++;
        }
        // Compute per-channel response times
        const guestMsgsByChannel = msgsByChannel.filter(m => m.role === MessageRole.GUEST);
        for (const gMsg of guestMsgsByChannel) {
          const nextReply = msgsByChannel.find(m =>
            m.conversationId === gMsg.conversationId &&
            m.role !== MessageRole.GUEST &&
            m.sentAt > gMsg.sentAt
          );
          if (nextReply) {
            const ch = gMsg.channel || 'OTHER';
            if (channelMap[ch]) channelMap[ch].responseTimes.push(nextReply.sentAt.getTime() - gMsg.sentAt.getTime());
          }
        }
        const byChannel = Object.entries(channelMap).map(([channel, data]) => ({
          channel,
          received: data.received,
          sent: data.sent,
          ai: data.ai,
          avgResponseTimeMs: data.responseTimes.length > 0
            ? Math.round(data.responseTimes.reduce((a, b) => a + b, 0) / data.responseTimes.length)
            : 0,
        }));

        // A8: Peak hours heatmap (day-of-week × hour)
        const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
        for (const m of messages) {
          const d = m.sentAt;
          heatmap[d.getDay()][d.getHours()]++;
        }

        res.json({
          period: { from: from.toISOString(), to: now.toISOString() },
          totals: { messagesReceived, messagesSent, aiMessagesSent, aiResolutionRate, avgResponseTimeMs, tasksCreated, tasksCompleted },
          byDay,
          byProperty,
          topUrgencies,
          responseTimeDistribution,
          byChannel,
          peakHoursHeatmap: heatmap,
        });
      } catch (err) {
        console.error('[Analytics] get error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  };
}
