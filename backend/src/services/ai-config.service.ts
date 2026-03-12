import * as fs from 'fs';
import * as path from 'path';

export interface AiPersonaConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  topK?: number;
  topP?: number;
  stopSequences?: string[];
  systemPrompt: string;
  responseSchema?: string;
  contentBlockTemplate?: string;
}

export interface AiConfig {
  debounceDelayMs?: number;
  messageHistoryCount?: number;
  guestCoordinator: AiPersonaConfig;
  screeningAI: AiPersonaConfig;
  managerTranslator: AiPersonaConfig;
  guardrails?: string[];
  escalation?: {
    confidenceThreshold: number;
    triggerKeywords: string[];
    maxConsecutiveAiReplies: number;
  };
}

let cachedConfig: AiConfig | null = null;

export function getAiConfig(): AiConfig {
  if (!cachedConfig) {
    const configPath = path.join(process.cwd(), 'src/config/ai-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    cachedConfig = JSON.parse(raw) as AiConfig;
  }
  return cachedConfig;
}

export function updateAiConfig(updates: Partial<AiConfig>): AiConfig {
  const current = getAiConfig();
  const next: AiConfig = {
    debounceDelayMs: updates.debounceDelayMs ?? current.debounceDelayMs,
    messageHistoryCount: updates.messageHistoryCount ?? current.messageHistoryCount,
    guestCoordinator: updates.guestCoordinator
      ? { ...current.guestCoordinator, ...updates.guestCoordinator }
      : current.guestCoordinator,
    screeningAI: updates.screeningAI
      ? { ...current.screeningAI, ...updates.screeningAI }
      : current.screeningAI,
    managerTranslator: updates.managerTranslator
      ? { ...current.managerTranslator, ...updates.managerTranslator }
      : current.managerTranslator,
    guardrails: updates.guardrails !== undefined ? updates.guardrails : current.guardrails,
    escalation: updates.escalation !== undefined ? updates.escalation : current.escalation,
  };
  const configPath = path.join(process.cwd(), 'src/config/ai-config.json');
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  cachedConfig = next;
  return next;
}
