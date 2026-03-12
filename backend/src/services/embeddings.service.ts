/**
 * OpenAI embeddings service — text-embedding-3-small (1536 dimensions).
 * Used ONLY for vector similarity search (RAG). Never for AI responses.
 * Gracefully disabled when OPENAI_API_KEY is missing.
 */
import OpenAI from 'openai';

let _openai: OpenAI | null = null;
let _warned = false;

interface CacheEntry {
  embedding: number[];
  ts: number;
}
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getClient(): OpenAI | null {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) {
    if (!_warned) {
      console.warn('[Embeddings] OPENAI_API_KEY missing — RAG embeddings disabled');
      _warned = true;
    }
    return null;
  }
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function cacheKey(text: string): string {
  return text.trim().toLowerCase().substring(0, 200);
}

export async function embedText(text: string): Promise<number[]> {
  const client = getClient();
  if (!client) return [];

  // Check cache (only for short texts worth caching)
  if (text.length <= 1000) {
    const key = cacheKey(text);
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.embedding;
    }
  }

  try {
    const res = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    const embedding = res.data[0].embedding;
    if (text.length <= 1000) {
      _cache.set(cacheKey(text), { embedding, ts: Date.now() });
    }
    return embedding;
  } catch (err) {
    console.error('[Embeddings] embedText failed:', err);
    return [];
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const client = getClient();
  if (!client) return texts.map(() => []);

  const results: number[][] = new Array(texts.length).fill([]).map(() => []);
  const BATCH_SIZE = 20;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
      });
      res.data.forEach((item, idx) => {
        results[i + idx] = item.embedding;
      });
    } catch (err) {
      console.error(`[Embeddings] embedBatch failed at offset ${i}:`, err);
    }
  }

  return results;
}
