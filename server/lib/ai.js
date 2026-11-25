// AI provider layer for server-side features (channel AI sessions). Chosen by env:
//   AI_PROVIDER=vertex     Gemini on Vertex AI with a service account: VERTEX_AI_PROJECT_ID, VERTEX_AI_LOCATION
//                          (default global), VERTEX_AI_CREDENTIALS_JSON (the service account key JSON)
//   AI_PROVIDER=gemini     Gemini API with GEMINI_API_KEY
//   AI_PROVIDER=anthropic  Claude Messages API with ANTHROPIC_API_KEY
//   AI_MODEL               optional model (default gemini-flash-latest, or claude-opus-5-5 for anthropic)
//   AI_TIMEOUT_MS          optional, per request (default 45000)
// Without a complete configuration aiConfigured() is false and callers do nothing.
// Errors are logged to ai_errors with the provider's status code only: never the prompt, the messages or the answer.
import Anthropic from '@anthropic-ai/sdk';
import { uuid, now } from './crypto.js';

export const PROVIDERS = ['vertex', 'gemini', 'anthropic'];
const ERROR_ROWS = 50;

export class AiError extends Error {
  constructor(provider, code, message) {
    super(message || code);
    this.provider = provider;
    this.code = code;
  }
}

/** The configured provider, or null when AI is not (completely) configured. */
export function aiProvider(env = {}) {
  const p = String(env.AI_PROVIDER || '').toLowerCase();
  if (p === 'vertex' && env.VERTEX_AI_PROJECT_ID && env.VERTEX_AI_CREDENTIALS_JSON) return 'vertex';
  if (p === 'gemini' && env.GEMINI_API_KEY) return 'gemini';
  if (p === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
export const aiConfigured = (env) => Boolean(aiProvider(env));

export function aiModel(env = {}) {
  if (env.AI_MODEL) return String(env.AI_MODEL);
  return aiProvider(env) === 'anthropic' ? 'claude-opus-5-5' : 'gemini-flash-latest';
}

/** What admins see: provider, model, and what is missing. No secrets. */
export function aiStatus(env = {}) {
  const provider = aiProvider(env);
  const wanted = String(env.AI_PROVIDER || '').toLowerCase() || null;
  let missing = null;
  if (!provider) {
    if (!wanted) missing = 'AI_PROVIDER (vertex, gemini or anthropic)';
    else if (wanted === 'vertex') missing = 'VERTEX_AI_PROJECT_ID and VERTEX_AI_CREDENTIALS_JSON';
    else if (wanted === 'gemini') missing = 'GEMINI_API_KEY';
    else if (wanted === 'anthropic') missing = 'ANTHROPIC_API_KEY';
    else missing = 'AI_PROVIDER must be vertex, gemini or anthropic';
  }
  return {
    configured: Boolean(provider),
    provider,
    model: provider ? aiModel(env) : null,
    location: provider === 'vertex' ? vertexLocation(env) : null,
    missing,
  };
}

export async function logAiError(db, provider, error, context) {
  try {
    await db.batch([
      {
        sql: 'INSERT INTO ai_errors (id, provider, error, context, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [uuid(), String(provider || 'none'), String(error).slice(0, 200), context ? String(context).slice(0, 200) : null, now()],
      },
      { sql: `DELETE FROM ai_errors WHERE id NOT IN (SELECT id FROM ai_errors ORDER BY created_at DESC LIMIT ${ERROR_ROWS})`, params: [] },
    ]);
  } catch (e) {
    console.error('ai: could not log error', e?.message);
  }
}

/** Plain words for an AiError code. */
export function explainAiError(code) {
  const c = String(code || '');
  if (c === 'timeout') return 'The AI service did not answer in time.';
  if (c === 'network_error') return 'Could not reach the AI service.';
  if (c === 'http_429' || /RESOURCE_EXHAUSTED|rate_limit/.test(c))
    return 'The AI service is limiting requests. It is tried again on the next run.';
  if (/http_40[13]|PERMISSION_DENIED|UNAUTHENTICATED|authentication|token_exchange/.test(c))
    return 'The AI service refused the credentials. An admin needs to check the AI settings on the server.';
  if (c === 'bad_json' || c === 'empty') return 'The AI answer could not be read. It is tried again on the next run.';
  if (c === 'refusal' || c === 'blocked') return 'The AI service declined to answer for these messages.';
  if (c === 'bad_credentials') return 'VERTEX_AI_CREDENTIALS_JSON is not a valid service account key.';
  return `The AI service returned an error (${c}).`;
}

// ---- HTTP with timeout and one retry ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(env, provider, url, init) {
  const fetchFn = env.fetch || fetch;
  const timeout = Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 45000;
  const retryMs = env.AI_RETRY_MS !== undefined ? Number(env.AI_RETRY_MS) : 1500;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res = null;
    let failure = null;
    try {
      res = await fetchFn(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      failure = e?.name === 'AbortError' ? 'timeout' : 'network_error';
    } finally {
      clearTimeout(timer);
    }
    const retryable = failure || res.status === 429 || res.status >= 500;
    if (retryable && attempt === 0) {
      if (retryMs > 0) await sleep(retryMs);
      continue;
    }
    if (failure) throw new AiError(provider, failure);
    return res;
  }
}

/** Status code plus the provider's error type (never its free text, which could echo the prompt). */
async function httpError(provider, res) {
  let kind = '';
  try {
    const d = await res.json();
    const e = Array.isArray(d) ? d[0]?.error : d?.error;
    kind = e?.status || e?.type || '';
  } catch {
    kind = '';
  }
  return new AiError(
    provider,
    `http_${res.status}${
      kind
        ? ` ${String(kind)
            .replace(/[^A-Za-z_]/g, '')
            .slice(0, 40)}`
        : ''
    }`,
  );
}

// ---- JSON schema helpers ----

/** Our JSON-schema-like spec to Gemini's OpenAPI subset (types upper case, no additionalProperties). */
export function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = geminiSchema(s.items);
  return out;
}

/** Claude structured outputs want additionalProperties: false on every object. */
function strictSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  if (s.type === 'object') {
    out.additionalProperties = false;
    out.properties = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, strictSchema(v)]));
    out.required = s.required || Object.keys(s.properties || {});
  }
  if (s.items) out.items = strictSchema(s.items);
  return out;
}

/** Parse a JSON answer; tolerates a ```json fence or text around the object. */
export function parseJsonAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Vertex AI service-account token ----

const tokenCache = new Map(); // client_email -> { token, exp (ms) }
/** Tests: forget cached access tokens. */
export function resetAiTokens() {
  tokenCache.clear();
}

const b64url = (bytes) => {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----(BEGIN|END) [^-]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function vertexLocation(env) {
  return String(env.VERTEX_AI_LOCATION || 'global');
}

function credentials(env) {
  let cred;
  try {
    cred = typeof env.VERTEX_AI_CREDENTIALS_JSON === 'string' ? JSON.parse(env.VERTEX_AI_CREDENTIALS_JSON) : env.VERTEX_AI_CREDENTIALS_JSON;
  } catch {
    throw new AiError('vertex', 'bad_credentials');
  }
  if (!cred?.client_email || !cred?.private_key) throw new AiError('vertex', 'bad_credentials');
  return cred;
}

/** A signed service-account JWT (RS256) for the OAuth token exchange. */
export async function serviceAccountJwt(cred, nowSec) {
  const header = { alg: 'RS256', typ: 'JWT', ...(cred.private_key_id ? { kid: cred.private_key_id } : {}) };
  const claims = {
    iss: cred.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: cred.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const input = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(claims))}`;
  let key;
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(cred.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'sign',
    ]);
  } catch {
    throw new AiError('vertex', 'bad_credentials');
  }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function vertexToken(env) {
  const cred = credentials(env);
  const hit = tokenCache.get(cred.client_email);
  if (hit && hit.exp - 60e3 > Date.now()) return hit.token;
  const jwt = await serviceAccountJwt(cred, Math.floor(Date.now() / 1000));
  const res = await send(env, 'vertex', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  if (!res.ok) throw new AiError('vertex', `token_exchange_${res.status}`);
  const d = await res.json().catch(() => ({}));
  if (!d.access_token) throw new AiError('vertex', 'token_exchange_empty');
  tokenCache.set(cred.client_email, { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 });
  return d.access_token;
}

// ---- providers ----

function geminiBody({ system, prompt, json, maxTokens }) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json', responseSchema: geminiSchema(json) } : {}),
    },
  };
}

async function geminiAnswer(provider, res) {
  if (!res.ok) throw await httpError(provider, res);
  const d = await res.json().catch(() => null);
  if (d?.promptFeedback?.blockReason) throw new AiError(provider, 'blocked');
  const cand = d?.candidates?.[0];
  if (!cand) throw new AiError(provider, 'empty');
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason)) throw new AiError(provider, 'blocked');
  return (cand.content?.parts || []).map((p) => p.text || '').join('');
}

function vertexUrl(env, model) {
  const loc = vertexLocation(env);
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(env.VERTEX_AI_PROJECT_ID)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

// Models that take server-side refusal fallbacks (fallbacks: "default", beta server-side-fallback-2026-07-01).
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5)/;

/** Claude through the official Anthropic SDK. env.fetch (tests) is passed to the client as its fetch. */
async function anthropicCall(env, model, { system, prompt, json, maxTokens }) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 45000,
    maxRetries: 1, // one retry on 408/409/429/5xx and connection errors, like the other providers
    ...(env.fetch ? { fetch: env.fetch } : {}),
  });
  const params = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: json ? `${prompt}\n\nAnswer with one JSON object only, matching the requested schema.` : prompt }],
    // summarising a channel is routine work: medium effort (Claude Opus 5.5's default, set explicitly)
    output_config: { effort: 'medium', ...(json ? { format: { type: 'json_schema', schema: strictSchema(json) } } : {}) },
  };
  let response;
  try {
    response = FALLBACK_MODELS.test(model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AiError('anthropic', 'timeout');
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('anthropic', 'network_error');
    if (e instanceof Anthropic.APIError) {
      const kind = String(e.error?.error?.type || '')
        .replace(/[^A-Za-z_]/g, '')
        .slice(0, 40);
      throw new AiError('anthropic', `http_${e.status}${kind ? ` ${kind}` : ''}`);
    }
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new AiError('anthropic', 'refusal');
  return (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * One completion. opts: { system, prompt, json (schema: answer must be that JSON), maxTokens }.
 * Returns { text, data (parsed JSON when json was asked), provider, model }. Throws AiError.
 */
export async function aiComplete(env, opts) {
  const provider = aiProvider(env);
  if (!provider) throw new AiError('none', 'not_configured', 'AI is not configured');
  const model = aiModel(env);
  const o = { maxTokens: 2048, ...opts };
  let text;
  if (provider === 'anthropic') {
    text = await anthropicCall(env, model, o);
  } else if (provider === 'gemini') {
    const res = await send(
      env,
      provider,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(geminiBody(o)),
      },
    );
    text = await geminiAnswer(provider, res);
  } else {
    const token = await vertexToken(env);
    const res = await send(env, provider, vertexUrl(env, model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(geminiBody(o)),
    });
    if (res.status === 401) tokenCache.clear();
    text = await geminiAnswer(provider, res);
  }
  if (!o.json) return { text, provider, model };
  const data = parseJsonAnswer(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AiError(provider, 'bad_json');
  return { text, data, provider, model };
}
