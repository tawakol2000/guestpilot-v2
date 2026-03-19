/**
 * Cohere Rerank Service — cross-encoder re-scoring for RAG retrieval.
 *
 * Cross-encoders process query + document tokens jointly, giving much better
 * semantic matching than cosine similarity on compressed embeddings. Especially
 * valuable for cross-lingual matching (Arabic query → English training example).
 *
 * Used in:
 * 1. RAG retrieval: re-score top-8 pgvector results → pick top-3 for AI context
 *
 * Gracefully disabled when COHERE_API_KEY is missing.
 * Cost: ~$2/1000 searches. At 100 messages/day = $6/month.
 */

import { CohereClientV2 } from 'cohere-ai';

let _client: CohereClientV2 | null = null;
let _warned = false;
let _enabled = true;

function getClient(): CohereClientV2 | null {
  if (!_enabled) return null;
  if (_client) return _client;
  if (!process.env.COHERE_API_KEY) {
    if (!_warned) {
      console.warn('[Rerank] COHERE_API_KEY missing — reranking disabled');
      _warned = true;
    }
    return null;
  }
  _client = new CohereClientV2({ token: process.env.COHERE_API_KEY });
  return _client;
}

export function setRerankEnabled(enabled: boolean): void {
  _enabled = enabled;
  console.log(`[Rerank] ${enabled ? 'Enabled' : 'Disabled'}`);
}

export function isRerankEnabled(): boolean {
  return _enabled && !!process.env.COHERE_API_KEY;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/**
 * Re-score documents against a query using Cohere's cross-encoder.
 * Returns results sorted by relevance (highest first).
 *
 * @param query - The search query (guest message)
 * @param documents - Array of document texts to re-score
 * @param topN - Number of top results to return (default: 3)
 * @returns Sorted results with original index and relevance score, or null if disabled/failed
 */
export async function rerank(
  query: string,
  documents: string[],
  topN = 3
): Promise<RerankResult[] | null> {
  const client = getClient();
  if (!client || documents.length === 0) return null;

  try {
    const res = await client.rerank({
      model: 'rerank-v3.5', // multilingual, 100+ languages including Arabic
      query,
      documents: documents,
      topN: Math.min(topN, documents.length),
    });

    return res.results.map(r => ({
      index: r.index,
      relevanceScore: r.relevanceScore,
    }));
  } catch (err: any) {
    console.warn(`[Rerank] Failed (non-fatal): ${err.message}`);
    return null;
  }
}
