// Провайдер LLM: OpenAI Chat Completions со строгим структурированным выводом.
// Интерфейс: complete({ messages, schema }) → { json, usage, model }.
// Модель, ключ и цены — только из .env.
import OpenAI from 'openai';

export function createOpenAIProvider(env = process.env) {
  const model = env.LLM_MODEL;
  if (!model) throw new Error('LLM_MODEL не задан в .env');
  const client = new OpenAI({ apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY, baseURL: env.LLM_BASE_URL || undefined, maxRetries: 4 });
  const temperature = env.LLM_TEMPERATURE === undefined || env.LLM_TEMPERATURE === '' ? undefined : Number(env.LLM_TEMPERATURE);
  const reasoning_effort = env.LLM_REASONING_EFFORT || undefined;

  return {
    model,
    async complete({ messages, schema }) {
      const res = await client.chat.completions.create({
        model,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(reasoning_effort ? { reasoning_effort } : {}),
        response_format: { type: 'json_schema', json_schema: { name: 'cqa_evaluation', strict: true, schema } },
      });
      const choice = res.choices?.[0];
      if (choice?.message?.refusal) throw new Error(`Модель отказалась: ${choice.message.refusal}`);
      if (choice?.finish_reason === 'length') throw new Error('Ответ обрезан по лимиту токенов');
      const text = choice?.message?.content || '';
      return {
        json: JSON.parse(text),
        model: res.model || model,
        usage: {
          input_tokens: res.usage?.prompt_tokens || 0,
          cached_input_tokens: res.usage?.prompt_tokens_details?.cached_tokens || 0,
          output_tokens: res.usage?.completion_tokens || 0,
        },
      };
    },
  };
}

/** Стоимость по ценам из .env (USD за 1M токенов). Без цен — null. */
export function costUSD(usage, env = process.env) {
  const pin = Number(env.LLM_PRICE_INPUT_PER_1M);
  const pout = Number(env.LLM_PRICE_OUTPUT_PER_1M);
  if (!pin || !pout) return null;
  const pcached = env.LLM_PRICE_CACHED_INPUT_PER_1M ? Number(env.LLM_PRICE_CACHED_INPUT_PER_1M) : pin;
  const uncached = usage.input_tokens - (usage.cached_input_tokens || 0);
  return Math.round(((uncached * pin + (usage.cached_input_tokens || 0) * pcached + usage.output_tokens * pout) / 1e6) * 1e6) / 1e6;
}

/**
 * Модель для перепроверки спорных критериев (LLM_ESCALATE_MODEL, например gpt-6.1-sol). Нет переменной — null.
 * Ключ и endpoint общие; reasoning и цены — свои: LLM_ESCALATE_REASONING_EFFORT, LLM_ESCALATE_PRICE_*.
 */
export function createEscalation(env = process.env) {
  if (!env.LLM_ESCALATE_MODEL) return null;
  const sub = {
    ...env,
    LLM_MODEL: env.LLM_ESCALATE_MODEL,
    LLM_REASONING_EFFORT: env.LLM_ESCALATE_REASONING_EFFORT ?? env.LLM_REASONING_EFFORT,
    LLM_PRICE_INPUT_PER_1M: env.LLM_ESCALATE_PRICE_INPUT_PER_1M,
    LLM_PRICE_CACHED_INPUT_PER_1M: env.LLM_ESCALATE_PRICE_CACHED_INPUT_PER_1M,
    LLM_PRICE_OUTPUT_PER_1M: env.LLM_ESCALATE_PRICE_OUTPUT_PER_1M,
  };
  return { provider: createOpenAIProvider(sub), cost: (usage) => costUSD(usage, sub) };
}
