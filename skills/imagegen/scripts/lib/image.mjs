import fs from 'node:fs';
import { parse } from './args.mjs';
import { loadConfig, requireCredentials } from './config.mjs';
import { appendLedger, assertGuards, describePlan, planCost, readLedger, summarize } from './cost.mjs';
import { ApiError, UsageError } from './errors.mjs';
import { apiCall, rawRequest } from './http.mjs';
import { MODELS, estimateImage, resolveModelKey } from './models.mjs';
import { assertCompleted, debugFile, finish, outputPath, rel, reuseCached, saveDebug, writeOutput } from './output.mjs';
import { MP, dimsFromAspect, humanBytes, parseSize, sha256, sniffImage, toNumber } from './util.mjs';

const OPTIONS = {
  tier: { type: 'string' },
  model: { type: 'string' },
  aspect: { type: 'string' },
  mp: { type: 'string' },
  size: { type: 'string' },
  ref: { type: 'string', multiple: true },
  seed: { type: 'string' },
  steps: { type: 'string' },
  guidance: { type: 'string' },
  format: { type: 'string' },
  out: { type: 'string' },
  'out-dir': { type: 'string' },
  'prompt-file': { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  force: { type: 'boolean' },
  'override-budget': { type: 'boolean' },
  json: { type: 'boolean' },
  timeout: { type: 'string' },
};

const SUPPORTS = {
  seed: ['schnell', 'pro', 'flex', 'max'],
  steps: ['schnell', 'flex'],
  guidance: ['flex'],
  format: ['pro', 'flex', 'max'],
};

const readPrompt = (values, positionals) => {
  const file = values['prompt-file'];
  const text = file
    ? (() => {
        if (!fs.existsSync(file)) throw new UsageError(`prompt file not found: ${file}`);
        return fs.readFileSync(file, 'utf8').trim();
      })()
    : positionals.join(' ').trim();
  if (!text) throw new UsageError('a prompt is required: image "description" or --prompt-file <file>');
  return text;
};

const resolveSize = (model, values, notes) => {
  if (model.fixedSize) {
    if (values.size || values.aspect || values.mp) notes.push('schnell always renders 1024x1024, ignoring the size options');
    return { ...model.fixedSize };
  }
  const size = values.size
    ? parseSize(values.size)
    : dimsFromAspect(values.aspect || '1:1', values.mp === undefined ? 1 : toNumber(values.mp, 'mp', { min: 0.1, max: 4 }));
  if (size.width * size.height > 4 * MP) throw new UsageError(`size ${size.width}x${size.height} is above 4 MP`);
  return size;
};

const resolveParams = (modelKey, values, notes) => {
  const params = { seed: null, steps: null, guidance: null, format: null };
  const parsers = {
    seed: (v) => toNumber(v, 'seed', { integer: true }),
    steps: (v) => toNumber(v, 'steps', { integer: true, min: 1, max: modelKey === 'schnell' ? 8 : 50 }),
    guidance: (v) => toNumber(v, 'guidance', { min: 1.5, max: 10 }),
    format: (v) => {
      const format = v === 'jpg' ? 'jpeg' : v;
      if (!['jpeg', 'png', 'webp'].includes(format)) throw new UsageError('--format: jpeg, png or webp');
      return format;
    },
  };
  for (const name of Object.keys(parsers)) {
    if (values[name] === undefined) continue;
    if (!SUPPORTS[name].includes(modelKey)) {
      notes.push(`--${name} is not supported by ${modelKey}, ignoring`);
      continue;
    }
    params[name] = parsers[name](values[name]);
  }
  if (modelKey === 'schnell' && params.steps === null) params.steps = MODELS.schnell.defaultSteps;
  return params;
};

const isUrl = (text) => /^https?:\/\//i.test(text);

const readRef = (ref) => {
  if (isUrl(ref)) return { url: ref };
  if (!fs.existsSync(ref)) throw new UsageError(`reference not found: ${ref}`);
  const buf = fs.readFileSync(ref);
  const type = sniffImage(buf);
  if (!type) throw new UsageError(`${ref}: only JPEG, PNG and WEBP are supported`);
  return { file: ref, buf, type };
};

const refHash = (ref) => (ref.url ? ref.url : sha256(ref.buf));

export const refForUnified = (ref) => (ref.url ? ref.url : `data:${ref.type.mime};base64,${ref.buf.toString('base64')}`);

const refBytes = async (ref) => {
  if (!ref.url) return { buf: ref.buf, type: ref.type };
  const res = await rawRequest(ref.url, { timeoutMs: 60000 });
  if (res.status !== 200) throw new UsageError(`could not download reference ${ref.url}: HTTP ${res.status}`);
  const type = sniffImage(res.body);
  if (!type) throw new UsageError(`${ref.url}: only JPEG, PNG and WEBP are supported`);
  return { buf: res.body, type };
};

const callModel = async ({ creds, model, prompt, size, params, refs, timeoutMs }) => {
  const runPath = `/accounts/${creds.accountId}/ai/run`;
  if (model.transport === 'json') {
    const json = { prompt, steps: params.steps };
    if (params.seed !== null) json.seed = params.seed;
    return apiCall(creds, { path: `${runPath}/${model.id}`, json, timeoutMs, retries: 2 });
  }
  if (model.transport === 'multipart') {
    const form = [
      ['prompt', prompt],
      ['width', String(size.width)],
      ['height', String(size.height)],
    ];
    for (const [index, ref] of refs.entries()) {
      const { buf, type } = await refBytes(ref);
      form.push([`input_image_${index}`, { filename: `ref${index}.${type.ext}`, contentType: type.mime, data: buf }]);
    }
    return apiCall(creds, { path: `${runPath}/${model.id}`, form, timeoutMs, retries: 2 });
  }
  const input = { prompt, width: size.width, height: size.height };
  if (params.seed !== null) input.seed = params.seed;
  if (params.steps !== null) input.steps = params.steps;
  if (params.guidance !== null) input.guidance = params.guidance;
  if (params.format) input.output_format = params.format;
  if (refs.length) input.input_images = refs.map(refForUnified);
  return apiCall(creds, { path: runPath, json: { model: model.id, input }, timeoutMs, retries: 2 });
};

const firstString = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value.url === 'string') return value.url;
  return null;
};

const imageBytes = async (data) => {
  const result = data.result ?? data;
  const candidate =
    firstString(result?.image) || firstString(result?.images?.[0]) || firstString(result?.output) || firstString(result?.url);
  if (!candidate) {
    saveDebug(data);
    const fields = Object.keys(result || {}).join(', ') || 'none';
    throw new ApiError(`no image in the response (fields: ${fields}); raw response saved to ${debugFile()}`);
  }
  if (isUrl(candidate)) {
    const res = await rawRequest(candidate, { timeoutMs: 120000 });
    if (res.status !== 200) throw new ApiError(`could not download the result: HTTP ${res.status}`, res.status);
    return res.body;
  }
  const encoded = candidate.startsWith('data:') ? candidate.slice(candidate.indexOf(',') + 1) : candidate;
  return Buffer.from(encoded, 'base64');
};

const findCached = (entries, key) =>
  [...entries].reverse().find((entry) => entry.key === key && entry.file && fs.existsSync(entry.file));

export const imageCommand = async (argv, { dryRun = false } = {}) => {
  const { values, positionals } = parse(argv, OPTIONS);
  const say = values.json ? () => {} : (line) => console.log(line);
  const cfg = loadConfig();
  const prompt = readPrompt(values, positionals);
  const { key: modelKey, label } = resolveModelKey(values);
  const model = MODELS[modelKey];
  const notes = [];
  const size = resolveSize(model, values, notes);
  const params = resolveParams(modelKey, values, notes);
  const refs = (values.ref || []).map(readRef);
  if (refs.length > model.maxRefs) {
    throw new UsageError(`${model.label} accepts up to ${model.maxRefs} references, got ${refs.length}`);
  }
  const key = sha256(JSON.stringify({ id: model.id, prompt, size, params, refs: refs.map(refHash) }));
  const entries = readLedger();
  const summary = summarize(entries);
  const plan = planCost(estimateImage(modelKey, { ...size, refs: refs.length, steps: params.steps }, cfg), cfg, summary);
  const base = { model: model.id, tier: label, width: size.width, height: size.height, neurons: plan.neurons, est_usd: plan.usd };

  say(`model: ${model.label} (${label}), ${model.id}`);
  say(`size: ${size.width}x${size.height}, references: ${refs.length}`);
  say(describePlan(plan));
  for (const note of notes) say(`note: ${note}`);

  const cached = values.force ? null : findCached(entries, key);
  if (cached) {
    const file = reuseCached({ cached: cached.file, out: values.out, label, prompt, key });
    say(`served from cache, nothing charged: ${rel(file)}`);
    return finish(values, { ...base, ok: true, cached: true, file, est_usd: 0, neurons: 0 });
  }

  if (dryRun || values['dry-run']) return finish(values, { ...base, ok: true, dry_run: true, free_left: plan.freeLeft });

  assertGuards({ usd: plan.usd, isVideo: false, yes: values.yes, overrideBudget: values['override-budget'] }, cfg, summary);
  const creds = requireCredentials();
  const timeoutMs = values.timeout ? toNumber(values.timeout, 'timeout', { min: 5, max: 3600, integer: true }) * 1000 : 180000;

  const response = await callModel({ creds, model, prompt, size, params, refs, timeoutMs });
  assertCompleted(response);
  const bytes = await imageBytes(response);
  const type = sniffImage(bytes);
  if (!type) {
    saveDebug(response);
    throw new ApiError(`the result does not look like an image (${bytes.length} bytes); raw response saved to ${debugFile()}`);
  }

  const file = outputPath({
    out: values.out,
    outDir: values['out-dir'] || cfg.outDir,
    label,
    prompt,
    key,
    ext: type.ext,
    force: values.force,
  });
  writeOutput(file, bytes);
  appendLedger({
    ts: new Date().toISOString(),
    cmd: 'image',
    tier: label,
    model: model.id,
    key,
    width: size.width,
    height: size.height,
    refs: refs.length,
    steps: params.steps,
    neurons: plan.neurons,
    est_usd: plan.usd,
    file,
    bytes: bytes.length,
    prompt: prompt.slice(0, 500),
  });
  say(`saved: ${rel(file)} (${humanBytes(bytes.length)})`);
  return finish(values, { ...base, ok: true, cached: false, file, bytes: bytes.length });
};
