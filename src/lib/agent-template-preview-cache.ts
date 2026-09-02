export interface AgentTemplatePreviewCache<T> {
  generation: number;
  entries: Record<string, T>;
}

export interface AgentTemplatePreviewRequest {
  generation: number;
}

export function agentTemplatePreviewCacheKey(projectId: string, templateKey: string): string {
  return JSON.stringify([projectId, templateKey]);
}

export function createAgentTemplatePreviewCache<T>(): AgentTemplatePreviewCache<T> {
  return { generation: 0, entries: {} };
}

export function beginAgentTemplatePreviewRequest<T>(
  cache: AgentTemplatePreviewCache<T>
): AgentTemplatePreviewRequest {
  return { generation: cache.generation };
}

export function invalidateAgentTemplatePreviews<T>(
  cache: AgentTemplatePreviewCache<T>
): AgentTemplatePreviewCache<T> {
  return { generation: cache.generation + 1, entries: {} };
}

export function cacheAgentTemplatePreview<T>(
  cache: AgentTemplatePreviewCache<T>,
  request: AgentTemplatePreviewRequest,
  key: string,
  preview: T
): AgentTemplatePreviewCache<T> {
  if (request.generation !== cache.generation) return cache;
  return { ...cache, entries: { ...cache.entries, [key]: preview } };
}
