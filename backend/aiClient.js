// Cliente mínimo para Claude desplegado en Azure AI Foundry (API Messages de Anthropic).
// Endpoint:  https://<recurso>.services.ai.azure.com/anthropic/v1/messages
// Auth:      header x-api-key (la clave NUNCA va en el código ni en el frontend: solo en .env)
// `model` es el NOMBRE DEL DEPLOYMENT que se le puso al modelo en Foundry.
//
// Variables: AZURE_AI_BASE_URL, AZURE_AI_API_KEY, AZURE_AI_DEPLOYMENT, AZURE_AI_TIMEOUT_MS (opcional)
// Se leen al llamar (no al cargar el módulo) para poder cambiarlas en tests.

const ANTHROPIC_VERSION = '2023-06-01';

class AiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code || 'AI_ERROR';
  }
}

// Acepta cualquier URL del recurso (incluso la del "proyecto" de Foundry) y se queda con el host:
// la ruta de Claude siempre es <host>/anthropic/v1/messages.
function normalizeBaseUrl(raw) {
  try {
    return `${new URL(raw).origin}/anthropic`;
  } catch {
    return null;
  }
}

function aiConfig() {
  return {
    baseUrl: process.env.AZURE_AI_BASE_URL ? normalizeBaseUrl(process.env.AZURE_AI_BASE_URL) : null,
    apiKey: process.env.AZURE_AI_API_KEY,
    deployment: process.env.AZURE_AI_DEPLOYMENT,
    timeoutMs: Number(process.env.AZURE_AI_TIMEOUT_MS || 60000),
  };
}

function isConfigured() {
  const { baseUrl, apiKey, deployment } = aiConfig();
  return Boolean(baseUrl && apiKey && deployment);
}

// Devuelve el texto de la respuesta. Lanza AiError si falla (sin incluir nunca la clave en el mensaje).
async function complete({ system, user, maxTokens = 1500 }) {
  const { baseUrl, apiKey, deployment, timeoutMs } = aiConfig();
  if (!baseUrl || !apiKey || !deployment) {
    throw new AiError('El servicio de IA no está configurado', { code: 'AI_NOT_CONFIGURED' });
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: deployment,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new AiError(timedOut ? 'La IA tardó demasiado en responder' : 'No se pudo contactar a la IA', {
      code: timedOut ? 'AI_TIMEOUT' : 'AI_UNREACHABLE',
    });
  }

  if (!response.ok) {
    throw new AiError(`La IA respondió con error ${response.status}`, { status: response.status, code: 'AI_HTTP_ERROR' });
  }

  const data = await response.json().catch(() => null);
  const text = (data?.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw new AiError('La IA devolvió una respuesta vacía', { code: 'AI_EMPTY' });
  return text;
}

module.exports = { complete, isConfigured, AiError, normalizeBaseUrl };
