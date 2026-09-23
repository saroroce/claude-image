import fs from 'node:fs';
import { parse } from './args.mjs';
import { loadConfig, requireCredentials, scriptPath } from './config.mjs';
import { appendLedger, assertGuards, describePlan, planCost, readLedger, summarize } from './cost.mjs';
import { ApiError, UsageError } from './errors.mjs';
import { apiCall, rawRequest } from './http.mjs';
import { refForUnified } from './image.mjs';
import { VIDEO, estimateVideo } from './models.mjs';
import { assertCompleted, debugFile, finish, outputPath, rel, reuseCached, saveDebug, writeOutput } from './output.mjs';
import { humanBytes, sha256, sniffImage, sniffMp4, toNumber } from './util.mjs';

const OPTIONS = {
  mode: { type: 'string' },
  duration: { type: 'string' },
  res: { type: 'string' },
  draft: { type: 'boolean' },
  audio: { type: 'boolean' },
  aspect: { type: 'string' },
  image: { type: 'string', multiple: true },
  video: { type: 'string' },
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

const ASPECTS = ['auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16'];
const RESOLUTIONS = ['hd', 'fhd'];
const MODES = ['t2v', 'i2v', 'v2v'];

const isUrl = (text) => /^https?:\/\//i.test(text);

const readPrompt = (values, positionals) => {
  const file = values['prompt-file'];
  if (file && !fs.existsSync(file)) throw new UsageError(`prompt file not found: ${file}`);
  const text = file ? fs.readFileSync(file, 'utf8').trim() : positionals.join(' ').trim();
  if (!text) throw new UsageError('a prompt is required: video "description" or --prompt-file <file>');
  return text;
};

const readImage = (ref) => {
  if (isUrl(ref)) return { url: ref };
  if (!fs.existsSync(ref)) throw new UsageError(`image not found: ${ref}`);
  const buf = fs.readFileSync(ref);
  const type = sniffImage(buf);
  if (!type) throw new UsageError(`${ref}: only JPEG, PNG and WEBP are supported`);
  return { file: ref, buf, type };
};

const resolveMode = (values, images) => {
  const mode = values.mode || (images.length ? 'i2v' : values.video ? 'v2v' : 't2v');
  if (!MODES.includes(mode)) throw new UsageError(`--mode: ${MODES.join(', ')}`);
  if (mode === 'i2v' && (images.length < 1 || images.length > 10)) {
    throw new UsageError('i2v needs 1 to 10 images (--image)');
  }
  if (mode === 't2v' && images.length) throw new UsageError('t2v does not take --image, use --mode i2v');
  if (mode === 'v2v' && !(values.video && isUrl(values.video))) {
    throw new UsageError('v2v needs --video with an https link to the source clip');
  }
  return mode;
};

export const videoCommand = async (argv, { dryRun = false } = {}) => {
  const { values, positionals } = parse(argv, OPTIONS);
  const say = values.json ? () => {} : (line) => console.log(line);
  const cfg = loadConfig();
  const prompt = readPrompt(values, positionals);
  const images = (values.image || []).map(readImage);
  const mode = resolveMode(values, images);
  const duration = values.duration === undefined ? 5 : toNumber(values.duration, 'duration', { integer: true, min: 5, max: 20 });
  const resolution = values.res || 'hd';
  if (!RESOLUTIONS.includes(resolution)) throw new UsageError(`--res: ${RESOLUTIONS.join(' or ')}`);
  const draft = Boolean(values.draft);
  if (draft && resolution !== 'hd') throw new UsageError('draft is available in hd only');
  const aspect = values.aspect || (mode === 't2v' ? '16:9' : 'auto');
  if (!ASPECTS.includes(aspect)) throw new UsageError(`--aspect: ${ASPECTS.join(', ')}`);
  const audio = Boolean(values.audio);

  const key = sha256(
    JSON.stringify({
      id: VIDEO.id,
      mode,
      prompt,
      duration,
      resolution,
      draft,
      audio,
      aspect,
      images: images.map((ref) => (ref.url ? ref.url : sha256(ref.buf))),
      video: values.video || null,
    }),
  );
  const entries = readLedger();
  const summary = summarize(entries);
  const plan = planCost(estimateVideo({ mode, resolution, draft, duration }, cfg), cfg, summary);
  const label = draft ? 'video-draft' : 'video';
  const base = { model: VIDEO.id, mode, duration, resolution, draft, aspect, est_usd: plan.usd };

  say(`model: ${VIDEO.label}, ${VIDEO.id}`);
  say(`mode: ${mode}${draft ? ' (draft)' : ''}, ${duration} s, ${resolution}, aspect ${aspect}, audio ${audio ? 'on' : 'off'}`);
  say(describePlan(plan));

  const cached = values.force
    ? null
    : [...entries].reverse().find((entry) => entry.key === key && entry.file && fs.existsSync(entry.file));
  if (cached) {
    const file = reuseCached({ cached: cached.file, out: values.out, label, prompt, key });
    say(`served from cache, nothing charged: ${rel(file)}`);
    return finish(values, { ...base, ok: true, cached: true, file, est_usd: 0 });
  }

  if (dryRun || values['dry-run']) return finish(values, { ...base, ok: true, dry_run: true });

  assertGuards({ usd: plan.usd, isVideo: true, yes: values.yes, overrideBudget: values['override-budget'] }, cfg, summary);
  const creds = requireCredentials();

  const input = { mode, prompt, resolution, duration, generate_audio: audio, aspect_ratio: aspect };
  if (draft) input.draft = true;
  if (mode === 'i2v') input.keyframes = images.map(refForUnified);
  if (mode === 'v2v') input.start_video = values.video;

  const timeoutMs = values.timeout ? toNumber(values.timeout, 'timeout', { min: 30, max: 7200, integer: true }) * 1000 : 900000;
  say('video generation can take several minutes, waiting for the response…');
  const response = await apiCall(creds, {
    path: `/accounts/${creds.accountId}/ai/run`,
    json: { model: VIDEO.id, input },
    timeoutMs,
    retries: 0,
  });
  assertCompleted(response);
  const result = response.result ?? response;
  if (typeof result?.video !== 'string' || !isUrl(result.video)) {
    saveDebug(response);
    throw new ApiError(`no video link in the response (fields: ${Object.keys(result || {}).join(', ') || 'none'}); raw response saved to ${debugFile()}`);
  }

  const download = await rawRequest(result.video, { timeoutMs: 300000 });
  if (download.status !== 200) throw new ApiError(`could not download the video: HTTP ${download.status} (the link lives about 2 hours)`, download.status);
  if (!sniffMp4(download.body)) {
    saveDebug(response);
    throw new ApiError(`the downloaded file does not look like an mp4 (${download.body.length} bytes); raw response saved to ${debugFile()}`);
  }

  const file = outputPath({
    out: values.out,
    outDir: values['out-dir'] || cfg.outDir,
    label,
    prompt,
    key,
    ext: 'mp4',
    force: values.force,
  });
  writeOutput(file, download.body);
  appendLedger({
    ts: new Date().toISOString(),
    cmd: 'video',
    tier: label,
    model: VIDEO.id,
    key,
    mode,
    duration,
    resolution,
    draft,
    neurons: 0,
    est_usd: plan.usd,
    file,
    bytes: download.body.length,
    draft_cache: typeof result.draft_cache === 'string' ? result.draft_cache : undefined,
    prompt: prompt.slice(0, 500),
  });
  say(`saved: ${rel(file)} (${humanBytes(download.body.length)})`);
  say(`next for a scroll-driven site: node "${scriptPath()}" frames "${rel(file)}"`);
  return finish(values, { ...base, ok: true, cached: false, file, bytes: download.body.length });
};
