import http from 'node:http';
import https from 'node:https';
import { apiBase } from './config.mjs';
import { ApiError } from './errors.mjs';

const REDIRECTS = [301, 302, 303, 307, 308];
const RETRYABLE = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const rawRequest = (urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 120000, redirects = 5 } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'http:' ? http : https;
    const finalHeaders = { ...headers };
    if (body) finalHeaders['content-length'] = String(body.length);
    const req = lib.request(url, { method, headers: finalHeaders }, (res) => {
      const status = res.statusCode;
      if (REDIRECTS.includes(status) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        const nextHeaders = Object.fromEntries(
          Object.entries(headers).filter(([name]) => next.origin === url.origin || name.toLowerCase() !== 'authorization'),
        );
        const keepBody = status === 307 || status === 308;
        resolve(
          rawRequest(next.toString(), {
            method: keepBody ? method : 'GET',
            headers: nextHeaders,
            body: keepBody ? body : null,
            timeoutMs,
            redirects: redirects - 1,
          }),
        );
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`timeout: no data for ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

export const encodeForm = async (fields) => {
  const form = new FormData();
  for (const [name, value] of fields) {
    if (typeof value === 'string') {
      form.append(name, value);
    } else {
      form.append(name, new Blob([value.data], { type: value.contentType }), value.filename);
    }
  }
  const response = new Response(form);
  return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
};

const hint = (status, message) => {
  if (/daily free allocation|neurons/i.test(message)) {
    return 'the daily free Workers AI allowance is used up (resets daily, UTC): wait or move to Workers Paid';
  }
  if (status === 401 || status === 403) {
    return 'check the token (permission Account / Workers AI: Read and Edit) and the Account ID, run status --check';
  }
  if (status === 402) return 'not enough Unified Billing credits: top up in the Cloudflare dashboard (AI Gateway, Credits Available, Manage)';
  if (status === 429) return 'too many requests, retry later';
  return '';
};

const parseApiResponse = (res) => {
  const text = res.body.toString('utf8');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const ok = res.status >= 200 && res.status < 300;
  if (ok && data && data.success !== false) return data;
  const first = Array.isArray(data?.errors) ? data.errors[0] : null;
  const raw = first?.message || data?.error?.message || data?.error || data?.message || text.slice(0, 200) || 'empty response';
  const message = String(raw);
  const extra = hint(res.status, message);
  throw new ApiError(`HTTP ${res.status}: ${message}${extra ? `. ${extra}` : ''}`, res.status, first?.code ?? null);
};

export const apiCall = async (creds, { method = 'POST', path, json, form, timeoutMs = 180000, retries = 0 }) => {
  const url = `${apiBase()}${path}`;
  const headers = { authorization: `Bearer ${creds.token}`, accept: 'application/json' };
  let body = null;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = Buffer.from(JSON.stringify(json));
  } else if (form) {
    const encoded = await encodeForm(form);
    headers['content-type'] = encoded.contentType;
    body = encoded.body;
  }
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await rawRequest(url, { method, headers, body, timeoutMs });
    } catch (err) {
      if (attempt < retries && RETRYABLE.includes(err.code)) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ApiError(`network error: ${err.message}`, 0, err.code ?? null);
    }
    const quotaExhausted = /daily free allocation|neurons/i.test(res.body.toString('utf8'));
    if (res.status === 429 && attempt < retries && !quotaExhausted) {
      const wait = Number(res.headers['retry-after']) || 2 * (attempt + 1);
      await sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    return parseApiResponse(res);
  }
};
