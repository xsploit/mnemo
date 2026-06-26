import { config } from '../config.js';

export interface GatewayModelInfo {
  id: string;
  name?: string;
  ownedBy?: string;
  type?: string;
  tags: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface GatewayModelCatalog {
  models: GatewayModelInfo[];
  source: 'gateway' | 'fallback';
  total: number;
  offset: number;
  limit: number;
  error?: string;
}

export const fallbackGatewayModelIds = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-chat',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.7-sonnet',
] as const;

let cached: { at: number; catalog: GatewayModelCatalog } | null = null;
const cacheTtlMs = 10 * 60 * 1000;

export async function listGatewayModels(query = '', limit = 25, offset = 0): Promise<GatewayModelCatalog> {
  const catalog = await loadGatewayModelCatalog();
  const normalized = query.trim().toLowerCase();
  const models = normalized
    ? catalog.models.filter((model) =>
        [model.id, model.name, model.ownedBy, model.type, ...model.tags].filter(Boolean).join(' ').toLowerCase().includes(normalized),
      )
    : catalog.models;
  const safeLimit = Math.max(1, limit);
  const safeOffset = Math.max(0, offset);
  return { ...catalog, total: models.length, offset: safeOffset, limit: safeLimit, models: models.slice(safeOffset, safeOffset + safeLimit) };
}

export function formatGatewayModelList(catalog: GatewayModelCatalog): string {
  const end = Math.min(catalog.total, catalog.offset + catalog.models.length);
  const lines = [
    `models=${catalog.total} showing=${catalog.offset + 1}-${end} source=${catalog.source}${catalog.error ? ` error=${catalog.error}` : ''}`,
    ...catalog.models.map((model, index) => {
      const details = [
        model.name && model.name !== model.id ? model.name : '',
        model.type,
        model.contextWindow ? `ctx=${model.contextWindow}` : '',
        model.maxTokens ? `max=${model.maxTokens}` : '',
        model.tags.length ? model.tags.slice(0, 3).join(',') : '',
      ].filter(Boolean);
      return `${index + 1}. ${model.id}${details.length ? ` (${details.join('; ')})` : ''}`;
    }),
  ];
  return lines.join('\n');
}

async function loadGatewayModelCatalog(): Promise<GatewayModelCatalog> {
  if (cached && Date.now() - cached.at < cacheTtlMs) return cached.catalog;
  const baseUrl = (config.gateway.baseURL || 'https://ai-gateway.vercel.sh/v1').replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.gateway.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
    const parsed = (await response.json()) as { data?: unknown[] };
    const models = (parsed.data ?? []).map(parseGatewayModel).filter((model): model is GatewayModelInfo => model !== null);
    const deduped = dedupeModels([...models, ...fallbackModels()]);
    const catalog: GatewayModelCatalog = { source: 'gateway', models: deduped, total: deduped.length, offset: 0, limit: deduped.length };
    cached = { at: Date.now(), catalog };
    return catalog;
  } catch (error) {
    const catalog: GatewayModelCatalog = {
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
      models: fallbackModels(),
      total: fallbackGatewayModelIds.length,
      offset: 0,
      limit: fallbackGatewayModelIds.length,
    };
    cached = { at: Date.now(), catalog };
    return catalog;
  }
}

function parseGatewayModel(value: unknown): GatewayModelInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: stringField(record, 'name'),
    ownedBy: stringField(record, 'owned_by'),
    type: stringField(record, 'type'),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    contextWindow: numberField(record, 'context_window'),
    maxTokens: numberField(record, 'max_tokens'),
  };
}

function fallbackModels(): GatewayModelInfo[] {
  return fallbackGatewayModelIds.map((id) => ({ id, ownedBy: id.split('/')[0], tags: [], type: 'language' }));
}

function dedupeModels(models: GatewayModelInfo[]): GatewayModelInfo[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
