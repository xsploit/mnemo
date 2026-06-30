import { config } from '../config.js';

export type ModelCatalogProvider = 'vercel' | 'zai' | 'zai-coding';
export type ModelCatalogSource = 'gateway' | 'zai' | 'zai-coding' | 'fallback';

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
  provider: ModelCatalogProvider;
  source: ModelCatalogSource;
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

const fallbackZaiModelIds = uniqueStrings([
  config.llm.modelDefaults.zai.chat,
  config.llm.modelDefaults.zai.dream,
  config.llm.modelDefaults.zai.json,
  ...csvEnv('GLM_MODEL_CATALOG'),
  'glm-4.5-flash',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4-plus',
]);

const fallbackZaiCodingModelIds = uniqueStrings([
  stripProviderPrefix(config.llm.modelDefaults['zai-coding'].chat),
  stripProviderPrefix(config.llm.modelDefaults['zai-coding'].dream),
  stripProviderPrefix(config.llm.modelDefaults['zai-coding'].json),
  ...csvEnv('GLM_CODING_MODEL_CATALOG'),
  'glm-5.2',
  'glm-4.7',
  'glm-4.5',
  'glm-4.5-flash',
]);

const cached = new Map<ModelCatalogProvider, { at: number; catalog: GatewayModelCatalog }>();
const cacheTtlMs = 10 * 60 * 1000;

export async function listGatewayModels(query = '', limit = 25, offset = 0): Promise<GatewayModelCatalog> {
  return listProviderModels('vercel', query, limit, offset);
}

export async function listProviderModels(
  provider: ModelCatalogProvider,
  query = '',
  limit = 25,
  offset = 0,
): Promise<GatewayModelCatalog> {
  const catalog = await loadProviderModelCatalog(provider);
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
    `provider=${catalog.provider} models=${catalog.total} showing=${catalog.offset + 1}-${end} source=${catalog.source}${catalog.error ? ` error=${catalog.error}` : ''}`,
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

export function modelCatalogProviderLabel(provider: ModelCatalogProvider): string {
  if (provider === 'zai-coding') return 'GLM Coding';
  if (provider === 'zai') return 'Z.ai GLM';
  return 'Vercel AI Gateway';
}

async function loadProviderModelCatalog(provider: ModelCatalogProvider): Promise<GatewayModelCatalog> {
  const hit = cached.get(provider);
  if (hit && Date.now() - hit.at < cacheTtlMs) return hit.catalog;
  if (provider === 'zai') return loadOpenAICompatibleCatalog(provider, config.zai.baseURL, config.zai.apiKey, fallbackZaiModelIds, 'zai');
  if (provider === 'zai-coding') return loadAnthropicCompatibleCatalog(provider, config.zaiCoding.baseURL, config.zaiCoding.apiKey, fallbackZaiCodingModelIds);
  return loadVercelGatewayCatalog();
}

async function loadVercelGatewayCatalog(): Promise<GatewayModelCatalog> {
  const baseUrl = (config.gateway.baseURL || 'https://ai-gateway.vercel.sh/v1').replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.gateway.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
    const parsed = (await response.json()) as { data?: unknown[] };
    const models = (parsed.data ?? []).map((item) => parseGatewayModel(item)).filter((model): model is GatewayModelInfo => model !== null);
    const deduped = dedupeModels([...models, ...fallbackModels()]);
    const catalog: GatewayModelCatalog = { provider: 'vercel', source: 'gateway', models: deduped, total: deduped.length, offset: 0, limit: deduped.length };
    cached.set('vercel', { at: Date.now(), catalog });
    return catalog;
  } catch (error) {
    const catalog: GatewayModelCatalog = {
      provider: 'vercel',
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
      models: fallbackModels(),
      total: fallbackGatewayModelIds.length,
      offset: 0,
      limit: fallbackGatewayModelIds.length,
    };
    cached.set('vercel', { at: Date.now(), catalog });
    return catalog;
  }
}

async function loadOpenAICompatibleCatalog(
  provider: ModelCatalogProvider,
  baseUrl: string,
  apiKey: string,
  fallbackIds: string[],
  source: ModelCatalogSource,
): Promise<GatewayModelCatalog> {
  const fallback = fallbackModelInfos(provider, fallbackIds);
  if (!apiKey) return fallbackCatalog(provider, fallback, 'missing API key');
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
    const parsed = (await response.json()) as { data?: unknown[] };
    const models = (parsed.data ?? []).map((item) => parseGatewayModel(item, provider)).filter((model): model is GatewayModelInfo => model !== null);
    const deduped = dedupeModels([...models, ...fallback]);
    const catalog: GatewayModelCatalog = { provider, source, models: deduped, total: deduped.length, offset: 0, limit: deduped.length };
    cached.set(provider, { at: Date.now(), catalog });
    return catalog;
  } catch (error) {
    return fallbackCatalog(provider, fallback, error instanceof Error ? error.message : String(error));
  }
}

async function loadAnthropicCompatibleCatalog(
  provider: ModelCatalogProvider,
  baseUrl: string,
  apiKey: string,
  fallbackIds: string[],
): Promise<GatewayModelCatalog> {
  const fallback = fallbackModelInfos(provider, fallbackIds);
  if (!apiKey) return fallbackCatalog(provider, fallback, 'missing API key');
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
    const parsed = (await response.json()) as { data?: unknown[] };
    const models = (parsed.data ?? []).map((item) => parseGatewayModel(item, provider)).filter((model): model is GatewayModelInfo => model !== null);
    const deduped = dedupeModels([...models, ...fallback]);
    const catalog: GatewayModelCatalog = { provider, source: 'zai-coding', models: deduped, total: deduped.length, offset: 0, limit: deduped.length };
    cached.set(provider, { at: Date.now(), catalog });
    return catalog;
  } catch (error) {
    return fallbackCatalog(provider, fallback, error instanceof Error ? error.message : String(error));
  }
}

function fallbackCatalog(provider: ModelCatalogProvider, models: GatewayModelInfo[], error: string): GatewayModelCatalog {
  const catalog: GatewayModelCatalog = {
    provider,
    source: 'fallback',
    error,
    models,
    total: models.length,
    offset: 0,
    limit: models.length,
  };
  cached.set(provider, { at: Date.now(), catalog });
  return catalog;
}

function parseGatewayModel(value: unknown, provider?: ModelCatalogProvider): GatewayModelInfo | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: stringField(record, 'name') ?? stringField(record, 'display_name'),
    ownedBy: stringField(record, 'owned_by') ?? provider,
    type: stringField(record, 'type'),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    contextWindow: numberField(record, 'context_window'),
    maxTokens: numberField(record, 'max_tokens'),
  };
}

function fallbackModels(): GatewayModelInfo[] {
  return fallbackGatewayModelIds.map((id) => ({ id, ownedBy: id.split('/')[0], tags: [], type: 'language' }));
}

function fallbackModelInfos(provider: ModelCatalogProvider, ids: string[]): GatewayModelInfo[] {
  return uniqueStrings(ids)
    .filter((id) => id && !/\s/.test(id))
    .map((id) => ({ id, ownedBy: provider, tags: ['configured'], type: 'language' }));
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

function csvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function stripProviderPrefix(id: string): string {
  return id.replace(/^(vercel|zai-coding|zai):/, '').trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
