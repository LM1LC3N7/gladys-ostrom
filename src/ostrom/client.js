// -----------------------------------------------------------------------------
// The only place that talks to the network: the OAuth2 client-credentials
// token of the Ostrom API and the GET requests of the customer's own data,
// with a timeout, a bounded body and an identifiable User-Agent.
//
// The session (one per set of credentials) sends one request at a time, at
// least REQUEST_GAP apart, and holds the token in memory only (never in
// /data, never logged). The token endpoint answering `invalid_client` or
// `unauthorized_client` (HTTP 400/401, a readable OAuth2 error) is the ONLY
// refusal: every other error (a 401/403 of the API, a 403 of the token
// endpoint, an unreadable answer, a 5xx) is passing.
//
// Error messages carry a code and a status at most, never the text of the
// answer (it may echo a name, an address or a contract number).
// -----------------------------------------------------------------------------

import {
  ENVIRONMENTS,
  MAX_BODY_BYTES,
  REQUEST_GAP,
  REQUEST_TIMEOUT,
  TOKEN_DEFAULT_LIFE,
  TOKEN_MARGIN,
  USER_AGENT,
} from '../constants.js';

export class OstromError extends Error {
  constructor(code, { status, retryAfter, oauth } = {}) {
    super(`Ostrom: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'OstromError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.oauth = oauth;
  }
}

/** OAuth2 errors of the token endpoint that mean the client itself is refused. */
const REFUSED = new Set(['invalid_client', 'unauthorized_client']);
const OAUTH_CODE = /^[a-z_]{1,40}$/;

/** Retry-After (seconds or an HTTP date, against the Date header) -> ms; undefined otherwise. */
export function retryAfterMs(value, dateHeader) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  const ref = Date.parse(dateHeader ?? '');
  // Without a readable Date of the server, a date cannot be measured.
  return Number.isFinite(at) && Number.isFinite(ref) ? Math.max(0, at - ref) : undefined;
}

/** The body as text, never more than `max` bytes (cut and refused beyond). */
export async function boundedText(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.().catch(() => {});
    throw new OstromError('too_large');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > max) throw new OstromError('too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new OstromError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The JSON object of a body; undefined when it is not one. */
function parseObject(text) {
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** One HTTP exchange: `{ status, body }` (body: a JSON object or undefined), or an OstromError. */
export async function exchange({
  fetchImpl,
  url,
  method = 'GET',
  headers = {},
  body,
  signal,
  timeout = REQUEST_TIMEOUT,
  maxBytes = MAX_BODY_BYTES,
}) {
  const timer = AbortSignal.timeout(timeout);
  const both = signal ? AbortSignal.any([signal, timer]) : timer;
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      ...(body !== undefined ? { body } : {}),
      signal: both,
      redirect: 'error',
    });
    text = await boundedText(response, maxBytes);
  } catch (err) {
    if (err instanceof OstromError) throw err;
    if (signal?.aborted) throw new OstromError('stopped');
    throw new OstromError(timer.aborted ? 'timeout' : 'network');
  }
  const status = response.status;
  if (status === 429) {
    throw new OstromError('rate_limited', {
      status,
      retryAfter: retryAfterMs(
        response.headers?.get?.('retry-after'),
        response.headers?.get?.('date'),
      ),
    });
  }
  if (status >= 500) throw new OstromError('server', { status });
  return { status, body: parseObject(text) };
}

const TOKEN_TEXT = /^[\x21-\x7e]{16,8192}$/;

/** The lifetime of a token (ms) from `expires_in`; a default otherwise. */
export function tokenLife(expiresIn) {
  return typeof expiresIn === 'number' &&
    Number.isFinite(expiresIn) &&
    expiresIn >= 60 &&
    expiresIn <= 24 * 3600
    ? expiresIn * 1000
    : TOKEN_DEFAULT_LIFE;
}

/**
 * One session of the API for one set of credentials
 * `{ clientId, clientSecret, environment }` (never logged, never stored).
 */
export class OstromSession {
  constructor({
    credentials,
    fetchImpl = globalThis.fetch,
    urls = ENVIRONMENTS[credentials.environment] ?? ENVIRONMENTS.production,
    monotonic = () => performance.now(),
    sleep,
    timeout,
    gap = REQUEST_GAP,
  }) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.urls = urls;
    this.monotonic = monotonic;
    this.sleep = sleep;
    this.timeout = timeout;
    this.gap = gap;
    this.token = undefined;
    this.tokenDue = 0;
    this.lane = Promise.resolve();
    this.lastSent = -Infinity;
    this.abort = new AbortController();
    this.closed = false;
    /** Requests sent (tests). */
    this.sent = 0;
  }

  /** Stops the session: the request in flight is aborted, nothing more is sent. */
  close() {
    this.closed = true;
    this.abort.abort();
    this.token = undefined;
  }

  /** One request at a time, REQUEST_GAP apart. */
  exclusive(fn) {
    const job = this.lane.then(fn, fn);
    this.lane = job.catch(() => {});
    return job;
  }

  async send(options) {
    if (this.closed) throw new OstromError('stopped');
    const wait = this.lastSent + this.gap - this.monotonic();
    if (wait > 0 && this.sleep) await this.sleep(wait);
    if (this.closed) throw new OstromError('stopped');
    this.lastSent = this.monotonic();
    this.sent += 1;
    try {
      return await exchange({
        fetchImpl: this.fetchImpl,
        signal: this.abort.signal,
        ...(this.timeout ? { timeout: this.timeout } : {}),
        ...options,
      });
    } finally {
      // The gap counts from the end of a request: a slow answer never shortens it.
      this.lastSent = this.monotonic();
    }
  }

  /** A new token (client credentials). Only a readable invalid_client is a refusal. */
  async login() {
    const { clientId, clientSecret } = this.credentials;
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const started = this.monotonic();
    const { status, body } = await this.send({
      url: this.urls.auth,
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (status !== 200) {
      const oauth =
        typeof body?.error === 'string' && OAUTH_CODE.test(body.error) ? body.error : undefined;
      if ((status === 400 || status === 401) && oauth && REFUSED.has(oauth)) {
        throw new OstromError('refused', { status, oauth });
      }
      throw new OstromError('login_failed', { status, oauth });
    }
    const token = body?.access_token;
    if (typeof token !== 'string' || !TOKEN_TEXT.test(token)) {
      throw new OstromError('bad_response', { status });
    }
    if (typeof body.token_type === 'string' && body.token_type.toLowerCase() !== 'bearer') {
      throw new OstromError('bad_response', { status });
    }
    const life = tokenLife(body.expires_in);
    this.token = token;
    // Counted from the moment the login was SENT: the answer may have been slow.
    this.tokenDue = started + life - Math.min(TOKEN_MARGIN, life * 0.2);
    return token;
  }

  /** A valid token (a login when none or close to its end). */
  async ensureToken() {
    if (!this.token || this.monotonic() >= this.tokenDue) {
      this.token = undefined;
      await this.login();
    }
    return this.token;
  }

  async getOnce(path, query, token) {
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const { status, body } = await this.send({
      url: `${this.urls.api}${path}${qs}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (status === 401 || status === 403) throw new OstromError('unauthorized', { status });
    if (status === 404) throw new OstromError('not_found', { status });
    if (status !== 200) throw new OstromError('http', { status });
    if (!body) throw new OstromError('bad_response', { status });
    return body;
  }

  /**
   * One authenticated GET; resolves the JSON object. A 401 of the API: one new
   * token and one new try; a second refusal stays a passing error.
   */
  get(path, query) {
    return this.exclusive(async () => {
      const token = await this.ensureToken();
      try {
        return await this.getOnce(path, query, token);
      } catch (err) {
        if (err.code !== 'unauthorized' || err.status !== 401) throw err;
        this.token = undefined;
        const fresh = await this.ensureToken();
        return this.getOnce(path, query, fresh);
      }
    });
  }
}
