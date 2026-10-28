export const DEFAULT_THINKING_CHOICE = '';
export const EXTENDED_RUN_BUDGET = Object.freeze({ maxInputTokens: 32768, maxOutputTokens: 4096, maxTotalTokens: 64000, maxDurationMs: 300000 });
export const CUSTOM_RUN_LIMITS = Object.freeze({ maxInputTokens: Object.freeze([1024, 32768]), maxOutputTokens: Object.freeze([1, 8192]), maxTotalTokens: Object.freeze([1, 200000]), maxDurationMs: Object.freeze([100, 600000]) });

const cloud = model => Boolean(model?.cloud || model?.isCloud || model?.provider === 'openai' || model?.provider === 'cloud' || /:cloud$/i.test(model?.name || ''));
const identity = model => `${model?.provider || (cloud(model) ? 'openai' : 'ollama')}::${model?.name || ''}`;
export const validThinkingValue = value => typeof value === 'boolean' || (typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\uD800-\uDFFF]/u.test(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value));
const local = model => model && !cloud(model) && model.local !== false && (model.provider || 'ollama') === 'ollama';

export function advertisedThinking(model) {
  const input = model?.thinking;
  if (!local(model) || !input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.values)
    || input.values.length < 1 || input.values.length > 16 || !input.values.every(validThinkingValue)) return null;
  const values = [...new Set(input.values)];
  if (Object.hasOwn(input, 'default') && !values.some(value => Object.is(value, input.default))) return null;
  const result = { values, ...(Object.hasOwn(input, 'default') ? { default: input.default } : {}) };
  return JSON.stringify(result).length <= 1200 ? result : null;
}

export function thinkingOptions(model) {
  return (advertisedThinking(model)?.values || []).map(value => ({ key: JSON.stringify(value), value,
    label: `${JSON.stringify(value)} · ${typeof value === 'boolean' ? 'boolean' : 'named setting'}` }));
}

export function resolveThinkingChoice({ model, thinkingChoice = DEFAULT_THINKING_CHOICE, thinkingModelKey } = {}) {
  if (thinkingChoice === DEFAULT_THINKING_CHOICE || thinkingChoice === null || thinkingChoice === undefined) return undefined;
  if (!local(model)) throw new Error('Explicit reasoning controls require a local Ollama model. Choose Model default for cloud.');
  if (thinkingModelKey !== undefined && thinkingModelKey !== identity(model)) throw new Error('The reasoning choice belongs to another model. Choose Model default or a current advertised setting.');
  if (typeof thinkingChoice !== 'string') throw new Error('Choose a JSON-encoded advertised reasoning setting or Model default.');
  const option = thinkingOptions(model).find(candidate => candidate.key === thinkingChoice);
  if (!option) throw new Error('This reasoning choice is no longer advertised by the selected model. Choose Model default or refresh its controls.');
  return option.value;
}

function budgetInteger(value, key) {
  const [minimum, maximum] = CUSTOM_RUN_LIMITS[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const label = { maxInputTokens: 'Per-round input-token ceiling including private continuation', maxOutputTokens: 'Cumulative output-token ceiling', maxTotalTokens: 'Cumulative total-token ceiling', maxDurationMs: 'Duration ceiling in milliseconds' }[key];
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer from ${minimum.toLocaleString('en-US')} to ${maximum.toLocaleString('en-US')}.`);
  return parsed;
}

export function resolveRunBudget({ budgetMode = 'default', customBudget } = {}) {
  if (budgetMode === 'default') return {};
  if (budgetMode === 'extended') return { ...EXTENDED_RUN_BUDGET };
  if (budgetMode !== 'custom') throw new Error('Choose Default, Extended or Custom run limits.');
  if (!customBudget || typeof customBudget !== 'object' || Array.isArray(customBudget)
    || Object.keys(customBudget).some(key => !Object.hasOwn(CUSTOM_RUN_LIMITS, key))) throw new Error('Custom run limits may override only per-round input, output tokens, total tokens and duration.');
  return Object.fromEntries(Object.keys(CUSTOM_RUN_LIMITS).map(key => [key, budgetInteger(customBudget[key], key)]));
}

export function resolveInteractiveRunOptions({ model, ...options } = {}) {
  const thinking = resolveThinkingChoice({ model, ...options });
  return { ...(thinking === undefined ? {} : { thinking }), budget: resolveRunBudget(options) };
}

export function effectiveRunBudget({ capabilities, imageCount = 0, desktop = false, ...options } = {}) {
  const advertised = capabilities?.defaultBudget || {};
  const known = key => Number.isSafeInteger(advertised[key]) && advertised[key] >= CUSTOM_RUN_LIMITS[key][0] && advertised[key] <= CUSTOM_RUN_LIMITS[key][1] ? advertised[key] : null;
  return { maxInputTokens: desktop || imageCount >= 3 ? 32768 : 16384,
    maxOutputTokens: known('maxOutputTokens'), maxTotalTokens: desktop || imageCount >= 3 ? 64000 : known('maxTotalTokens'),
    maxDurationMs: desktop ? 300000 : known('maxDurationMs'), ...resolveRunBudget(options) };
}
