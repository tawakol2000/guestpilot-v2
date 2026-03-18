/**
 * Dual-provider embeddings service — OpenAI text-embedding-3-small (1536d)
 * or Cohere embed-multilingual-v3.0 (1024d) with input_type support.
 *
 * Provider is selected at runtime via setEmbeddingProvider().
 * Cohere's input_type parameter optimizes embeddings for classification
 * vs search, improving accuracy especially for multilingual (Arabic+English).
 */

import OpenAI from 'openai';
import { CohereClientV2 } from 'cohere-ai';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EmbeddingInputType = 'classification' | 'search_query' | 'search_document';
export type EmbeddingProvider = 'openai' | 'cohere';

// ─── State ───────────────────────────────────────────────────────────────────

let _activeProvider: EmbeddingProvider = 'openai';
let _openai: OpenAI | null = null;
let _cohere: CohereClientV2 | null = null;
let _warnedOpenAI = false;
let _warnedCohere = false;

interface CacheEntry { embedding: number[]; ts: number; }
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

// ─── Provider Management ─────────────────────────────────────────────────────

export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  _activeProvider = provider;
  _cache.clear(); // embeddings from different providers aren't compatible
  console.log(`[Embeddings] Active provider set to: ${provider}`);
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return _activeProvider;
}

export function getEmbeddingDimensions(): number {
  return _activeProvider === 'cohere' ? 1024 : 1536;
}

// ─── Client Initialization ───────────────────────────────────────────────────

function getOpenAIClient(): OpenAI | null {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) {
    if (!_warnedOpenAI) {
      console.warn('[Embeddings] OPENAI_API_KEY missing — OpenAI embeddings disabled');
      _warnedOpenAI = true;
    }
    return null;
  }
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function getCohereClient(): CohereClientV2 | null {
  if (_cohere) return _cohere;
  if (!process.env.COHERE_API_KEY) {
    if (!_warnedCohere) {
      console.warn('[Embeddings] COHERE_API_KEY missing — Cohere embeddings disabled');
      _warnedCohere = true;
    }
    return null;
  }
  _cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });
  return _cohere;
}

// ─── OpenAI Implementation ───────────────────────────────────────────────────

async function openaiEmbedText(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  if (!client) return [];
  try {
    const res = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return res.data[0].embedding;
  } catch (err) {
    console.error('[Embeddings/OpenAI] embedText failed:', err);
    return [];
  }
}

async function openaiEmbedBatch(texts: string[]): Promise<number[][]> {
  const client = getOpenAIClient();
  if (!client) return texts.map(() => []);
  const results: number[][] = new Array(texts.length).fill(null).map(() => []);
  const BATCH_SIZE = 20;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: batch,
      });
      res.data.forEach((item, idx) => { results[i + idx] = item.embedding; });
    } catch (err) {
      console.error(`[Embeddings/OpenAI] embedBatch failed at offset ${i}:`, err);
    }
  }
  return results;
}

// ─── Cohere Implementation ───────────────────────────────────────────────────

function mapInputType(inputType?: EmbeddingInputType): 'classification' | 'search_query' | 'search_document' {
  return inputType || 'search_query';
}

async function cohereEmbedText(text: string, inputType?: EmbeddingInputType): Promise<number[]> {
  const client = getCohereClient();
  if (!client) return [];
  try {
    const res = await client.embed({
      model: 'embed-v4.0',
      texts: [text],
      inputType: mapInputType(inputType),
      embeddingTypes: ['float'],
      outputDimension: 1024,
    });
    const embeddings = res.embeddings;
    if (embeddings && 'float' in embeddings && Array.isArray(embeddings.float) && embeddings.float[0]) {
      return embeddings.float[0];
    }
    return [];
  } catch (err) {
    console.error('[Embeddings/Cohere] embedText failed:', err);
    return [];
  }
}

async function cohereEmbedBatch(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]> {
  const client = getCohereClient();
  if (!client) return texts.map(() => []);
  const results: number[][] = new Array(texts.length).fill(null).map(() => []);
  const BATCH_SIZE = 96; // Cohere supports up to 96 texts per call
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await client.embed({
        model: 'embed-v4.0',
        texts: batch,
        inputType: mapInputType(inputType),
        embeddingTypes: ['float'],
        outputDimension: 1024,
      });
      const embeddings = res.embeddings;
      if (embeddings && 'float' in embeddings && Array.isArray(embeddings.float)) {
        embeddings.float.forEach((emb: number[], idx: number) => {
          results[i + idx] = emb;
        });
      }
    } catch (err) {
      console.error(`[Embeddings/Cohere] embedBatch failed at offset ${i}:`, err);
    }
  }
  return results;
}

// ─── Public API (delegates to active provider) ───────────────────────────────

function cacheKey(text: string, inputType?: EmbeddingInputType): string {
  return `${_activeProvider}:${inputType || 'default'}:${text.trim().toLowerCase().substring(0, 200)}`;
}

export async function embedText(text: string, inputType?: EmbeddingInputType): Promise<number[]> {
  // Check cache
  if (text.length <= 1000) {
    const key = cacheKey(text, inputType);
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.embedding;
    }
  }

  const embedding = _activeProvider === 'cohere'
    ? await cohereEmbedText(text, inputType)
    : await openaiEmbedText(text);

  if (embedding.length > 0 && text.length <= 1000) {
    _cache.set(cacheKey(text, inputType), { embedding, ts: Date.now() });
  }
  return embedding;
}

export async function embedBatch(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]> {
  return _activeProvider === 'cohere'
    ? cohereEmbedBatch(texts, inputType)
    : openaiEmbedBatch(texts);
}
