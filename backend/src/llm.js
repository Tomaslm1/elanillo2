// Cliente LLM con salida JSON estructurada.
//   Proveedor principal: Claude en Microsoft Foundry (SDK oficial @anthropic-ai/foundry-sdk).
//   Respaldo: Azure OpenAI `model-router` (endpoint compatible /openai/v1), usado si Claude falla
//   o rechaza la solicitud, o siempre si LLM_PROVIDER=azure-openai.
// En tests se reemplaza con setLlm(fake) para no salir a internet.
const { AnthropicFoundry } = require('@anthropic-ai/foundry-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { HttpError } = require('./http');
const { logger, metrics } = require('./logger');
const { validate } = require('./stages/schemas');

let override = null;
let anthropicClient = null;
let openaiClient = null;

function setLlm(fake) {
  override = fake;
}

// Opus puede tardar varios minutos en una especificación completa: el timeout por intento es amplio.
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS || 600000);
// Schemas que Claude no puede compilar como gramática estricta ("compiled grammar is too large").
const oversizedSchemas = new Set();
const anthropicConfigured = () => Boolean(process.env.ANTHROPIC_FOUNDRY_API_KEY && (process.env.ANTHROPIC_FOUNDRY_RESOURCE || process.env.ANTHROPIC_FOUNDRY_BASE_URL));
const azureOpenAIConfigured = () => Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_BASE_URL);

function providerOrder() {
  const preferred = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const order = preferred === 'azure-openai' ? ['azure-openai', 'anthropic'] : ['anthropic', 'azure-openai'];
  return order.filter((p) => (p === 'anthropic' ? anthropicConfigured() : azureOpenAIConfigured()));
}

// ---------- Claude (Foundry) ----------
function getAnthropic() {
  if (!anthropicClient) {
    anthropicClient = new AnthropicFoundry({
      apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
      resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE || undefined,
      baseURL: process.env.ANTHROPIC_FOUNDRY_BASE_URL || undefined,
      timeout: timeoutMs(),
      maxRetries: 1,
    });
  }
  return anthropicClient;
}

async function claudeRequest({ system, messages, schema }) {
  const strict = Boolean(schema);
  // Streaming + finalMessage: las respuestas pueden ser largas (especificaciones completas).
  const stream = getAnthropic().messages.stream({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    max_tokens: Number(process.env.LLM_MAX_TOKENS || 64000),
    // El prompt de sistema es igual en cada turno de la misma etapa: se cachea.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: {
      effort: process.env.LLM_EFFORT || 'medium',
      ...(strict ? { format: { type: 'json_schema', schema } } : {}),
    },
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const error = new Error(`Claude rechazó la solicitud (${message.stop_details?.category || 'sin categoría'})`);
    error.refusal = true;
    throw error;
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('La respuesta de Claude superó el máximo de tokens');
  }
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  if (!text) throw new Error(`Respuesta vacía de Claude (stop_reason=${message.stop_reason})`);
  return { text, model: message.model, usage: message.usage };
}

// Extrae el objeto JSON de una respuesta en texto libre (tolera ```json ... ```).
function parseJsonText(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('La respuesta no contiene un objeto JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function completeWithClaude({ system, messages, schema, name }) {
  if (!oversizedSchemas.has(name)) {
    try {
      const { text, model, usage } = await claudeRequest({ system, messages, schema });
      return { data: JSON.parse(text), model, usage };
    } catch (err) {
      if (!(err?.status === 400 && /grammar is too large/i.test(err.message || ''))) throw err;
      oversizedSchemas.add(name);
      logger.warn('llm_schema_too_large', { schema: name });
    }
  }

  // Sin gramática estricta: el schema va en las instrucciones y la salida se valida aquí, con una corrección.
  const jsonSystem = `${system}\n\nFORMATO DE SALIDA (obligatorio): responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques de código, que cumpla exactamente este JSON Schema (todas las propiedades son obligatorias; usa null donde el schema lo permita):\n${JSON.stringify(schema)}`;
  let { text, model, usage } = await claudeRequest({ system: jsonSystem, messages });
  let data;
  let errors;
  try {
    data = parseJsonText(text);
    errors = validate(schema, data);
  } catch (err) {
    errors = [err.message];
  }
  if (errors.length) {
    ({ text, model, usage } = await claudeRequest({
      system: jsonSystem,
      messages: [...messages, { role: 'assistant', content: text }, {
        role: 'user',
        content: `Tu JSON no cumple el schema. Errores:\n${errors.slice(0, 25).map((e) => `- ${e}`).join('\n')}\nDevuelve el objeto JSON completo y corregido, sin texto adicional.`,
      }],
    }));
    data = parseJsonText(text);
    errors = validate(schema, data);
    if (errors.length) throw new Error(`La salida de Claude no cumple el schema: ${errors.slice(0, 3).join('; ')}`);
  }
  return { data, model, usage };
}

// ---------- Azure OpenAI model-router (respaldo) ----------
function getOpenAI() {
  if (!openaiClient) {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    openaiClient = new OpenAI({
      apiKey,
      baseURL: process.env.AZURE_OPENAI_BASE_URL,
      defaultHeaders: { 'api-key': apiKey },
      timeout: timeoutMs(),
      maxRetries: 2,
    });
  }
  return openaiClient;
}

async function completeWithAzureOpenAI({ system, messages, schema, name }) {
  const response = await getOpenAI().chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || 'model-router',
    messages: [{ role: 'system', content: system }, ...messages],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  });
  const choice = response.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error(`Respuesta vacía del modelo (finish_reason=${choice?.finish_reason})`);
  return { data: JSON.parse(text), model: response.model, usage: response.usage };
}

function describeError(err) {
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) return `${err.constructor.name} ${err.status}: ${err.message}`;
  return err.message;
}

/**
 * Pide al modelo una respuesta que cumpla `schema` (JSON Schema estricto) y la devuelve parseada.
 * Intenta los proveedores en orden; si el primero falla, usa el siguiente.
 * @param {{system: string, messages: {role: 'user'|'assistant', content: string}[], schema: object, name: string}} args
 */
async function completeJson(args) {
  if (override) return override.completeJson(args);

  const providers = providerOrder();
  if (!providers.length) {
    throw new HttpError(503, 'El asistente de IA no está configurado en el servidor', { code: 'LLM_NOT_CONFIGURED' });
  }

  for (const provider of providers) {
    metrics.llmCalls += 1;
    const started = Date.now();
    try {
      const run = provider === 'anthropic' ? completeWithClaude : completeWithAzureOpenAI;
      const { data, model, usage } = await run(args);
      logger.info('llm_call', { provider, schema: args.name, model, ms: Date.now() - started, usage });
      return data;
    } catch (err) {
      metrics.llmErrors += 1;
      logger.error('llm_error', { provider, schema: args.name, error: describeError(err), ms: Date.now() - started, refusal: Boolean(err.refusal) });
    }
  }
  throw new HttpError(502, 'El asistente de IA no respondió correctamente. Intenta de nuevo.', { code: 'LLM_ERROR' });
}

module.exports = { completeJson, setLlm };
