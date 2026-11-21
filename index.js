/**
 * Auto Model Fallback Plugin
 *
 * Listens for model-request failures with QUOTA / ACCOUNT_QUOTA codes.
 * When detected, switches the session's default model to a fallback provider
 * that has available quota, injects a notification for the agent, and
 * requests a retry so work resumes without user intervention.
 *
 * Config (cordis.patch.yml):
 *   fallbackModels: [{ provider: 'openai', model: 'gpt-4o' }, ...]
 *     – priority list of fallback provider+model pairs (leave empty for auto-discovery)
 *   quotaCodes: ['QUOTA', 'ACCOUNT_QUOTA']
 *     – failure codes that trigger a switch
 *   notify: true
 *     – whether to inject a developer message after switching
 *   maxAttempts: 3
 *     – max fallback switches per single step (prevents infinite loops)
 */

/** Runtime state key for per-session attempt tracking */
const STATE_KEY = 'autoModelFallbackAttempts';

export function apply(ctx, config) {
  const quotaCodes = (config?.quotaCodes || ['QUOTA', 'ACCOUNT_QUOTA']).map((c) =>
    c.toUpperCase()
  );
  const notify = config.notify !== false;
  const maxAttempts = Math.max(1, config.maxAttempts || 3);
  const fallbackList = config.fallbackModels || [];

  // Track attempts per (sessionId:turn:step) to prevent infinite loops
  const attempts = new Map();

  // ── Agent lifecycle: clean up per-agent state ──
  ctx.on('agent/created', ({ agent }) => {
    // Nothing to init here; cleanup happens on dispose
  });

  ctx.on('agent/disposed', ({ agent }) => {
    for (const key of [...attempts.keys()]) {
      if (key.startsWith(agent.id + ':')) {
        attempts.delete(key);
      }
    }
  });

  // ── Core: intercept model-request failures ──
  const onRequestError = ctx.on(
    'agent/request-error',
    async ({ agent, turn, step, provider, failure, retryPolicy, signal }, next) => {
      // Let downstream listeners (e.g., dsh-llm-retry) handle it first
      const downstream = await next();

      // Check if this is a quota-type failure
      const code = (failure.code || '').toUpperCase();
      if (!quotaCodes.includes(code)) {
        return downstream;
      }

      // Guard: too many fallback attempts for this step
      const key = `${agent.id}:${turn}:${step}`;
      const currentAttempts = attempts.get(key) || 0;
      if (currentAttempts >= maxAttempts) {
        return downstream; // Give up – too many retries
      }
      attempts.set(key, currentAttempts + 1);

      // ── Find a fallback model ──
      const fallback = await pickFallbackModel(ctx, fallbackList, provider);
      if (!fallback) {
        return downstream; // No alternative available
      }

      // ── Switch the model ──
      let switched = false;
      try {
        const modelSvc = ctx.get('agentDefaultModel');
        if (modelSvc && typeof modelSvc.saveSelection === 'function') {
          await modelSvc.saveSelection({
            provider: fallback.provider,
            model: fallback.model,
          });
          switched = true;
        }
      } catch (err) {
        ctx.logger?.warn?.(`[auto-model-fallback] saveSelection failed: ${err.message}`);
      }

      if (!switched) {
        return downstream; // Could not switch
      }

      // ── Notify the agent via developer message ──
      if (notify) {
        try {
          const msg = `[自动切换模型] 当前模型 (${provider}) 额度不足，已切换到 ${fallback.provider}/${fallback.model}。请继续任务。`;
          // Inject a developer message into the agent's inbox
          if (typeof agent.inject === 'function') {
            agent.inject([{ role: 'developer', content: [{ type: 'text', text: msg }] }]);
          }
        } catch (err) {
          ctx.logger?.warn?.(`[auto-model-fallback] inject failed: ${err.message}`);
        }
      }

      // ── Request retry with the new model ──
      return { kind: 'retry' };
    }
  );

  // ── Cleanup on plugin unload ──
  return () => {
    onRequestError();
    attempts.clear();
  };
}

/**
 * Pick a fallback model, prioritizing user-configured list, then auto-discovery.
 */
async function pickFallbackModel(ctx, fallbackList, currentProvider) {
  // 1) Try user-configured fallbacks first (skip current provider)
  for (const candidate of fallbackList) {
    if (candidate.provider === currentProvider) continue;
    if (await isModelAvailable(ctx, candidate.provider, candidate.model)) {
      return candidate;
    }
  }

  // 2) Auto-discover: iterate registered providers, skip current
  try {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.listProviders !== 'function') return null;

    const providers = await llm.listProviders();
    for (const p of providers) {
      if (p.id === currentProvider) continue;
      // Try to list models for this provider
      if (typeof llm.listModels === 'function') {
        try {
          const models = await llm.listModels(p.id);
          if (models && models.length > 0) {
            return { provider: p.id, model: models[0].id };
          }
        } catch (_) {
          // Provider might not support listModels or has no models
        }
      }
      // Fallback: if we know the provider but can't list models,
      // try a common default model name
      const defaultModel = getDefaultModelForProvider(p.id);
      if (defaultModel) {
        return { provider: p.id, model: defaultModel };
      }
    }
  } catch (_) {
    // Discovery failed
  }

  return null;
}

/** Check if a specific provider+model is available */
async function isModelAvailable(ctx, provider, model) {
  try {
    const llm = ctx.get('llm');
    if (!llm) return false;
    if (typeof llm.resolveModelInfo === 'function') {
      await llm.resolveModelInfo(provider, model);
      return true;
    }
    // If resolveModelInfo not available, check via listModels
    if (typeof llm.listModels === 'function') {
      const models = await llm.listModels(provider);
      return models.some((m) => m.id === model);
    }
  } catch (_) {
    return false;
  }
  // Can't verify; assume available
  return true;
}

/** Map well-known provider IDs to a default model name */
function getDefaultModelForProvider(providerId) {
  const map = {
    openai: 'gpt-4o',
    'openai-compatible': 'gpt-4o',
    google: 'gemini-2.5-pro',
    anthropic: 'claude-sonnet-4-20250514',
    deepseek: 'deepseek-chat',
    zhipu: 'glm-4-plus',
    'volcengine': 'doubao-seed-1-6-flash-250616',
  };
  return map[providerId] || null;
}
