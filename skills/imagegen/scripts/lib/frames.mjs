import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from './args.mjs';
import { ConfigError, UsageError } from './errors.mjs';
import { finish, rel } from './output.mjs';
import { MP, humanBytes, toNumber } from './util.mjs';

const OPTIONS = {
  out: { type: 'string' },
  fps: { type: 'string' },
  width: { type: 'string' },
  'max-frames': { type: 'string' },
  format: { type: 'string' },
  quality: { type: 'string' },
  mobile: { type: 'string' },
  'mobile-max-frames': { type: 'string' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
};

const HEAVY_BYTES = 25 * MP;

const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * MP });

const requireTool = (name) => {
  const res = run(name, ['-version']);
  if (res.error || res.status !== 0) {
    throw new ConfigError(`${name} not found. Install ffmpeg (macOS: brew install ffmpeg, Ubuntu: sudo apt install ffmpeg)`);
  }
};

const probe = (file) => {
  const res = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,duration:format=duration',
    '-of',
    'json',
    file,
  ]);
  if (res.status !== 0) throw new UsageError(`ffprobe could not read ${file}: ${res.stderr.trim().slice(0, 200)}`);
  const data = JSON.parse(res.stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new UsageError(`${file}: no video stream`);
  return {
    width: stream.width,
    height: stream.height,
    duration: Number(stream.duration) || Number(data.format?.duration) || 0,
  };
};

const encoders = {
  webp: (quality) => ['-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '4'],
  jpg: (quality) => [
    '-c:v',
    'mjpeg',
    '-q:v',
    String(Math.min(31, Math.max(2, Math.round((100 - quality) / 4)))),
    '-pix_fmt',
    'yuvj420p',
  ],
};

const canEncode = (format, quality) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-probe-'));
  try {
    const res = run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:d=0.1:r=1',
      '-frames:v',
      '1',
      ...encoders[format](quality),
      path.join(dir, `probe.${format}`),
    ]);
    return res.status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const pickFormat = (requested, quality) => {
  if (requested === 'auto') return canEncode('webp', quality) ? 'webp' : 'jpg';
  if (!encoders[requested]) throw new UsageError('--format: auto, webp or jpg');
  if (!canEncode(requested, quality)) {
    throw new ConfigError(`this ffmpeg cannot encode ${requested} (codec missing), use --format jpg`);
  }
  return requested;
};

const extract = ({ input, dir, fps, width, format, quality }) => {
  fs.mkdirSync(dir, { recursive: true });
  const res = run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-an',
    '-vf',
    `fps=${fps},scale=${width}:-2:flags=lanczos`,
    ...encoders[format](quality),
    '-start_number',
    '1',
    path.join(dir, `frame_%04d.${format}`),
  ]);
  if (res.status !== 0) throw new UsageError(`ffmpeg failed: ${res.stderr.trim().slice(0, 300)}`);
  const pattern = new RegExp(`^frame_\\d+\\.${format}$`);
  const files = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort();
  if (!files.length) throw new UsageError('ffmpeg produced no frames');
  const bytes = files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  return { count: files.length, bytes, first: path.join(dir, files[0]) };
};

const buildSet = ({ input, dir, info, fpsCap, widthCap, maxFrames, format, quality }) => {
  const width = Math.min(widthCap, info.width) - (Math.min(widthCap, info.width) % 2);
  const fps = info.duration > 0 ? Math.max(0.5, Math.min(fpsCap, Math.floor((maxFrames / info.duration) * 100) / 100)) : fpsCap;
  const extracted = extract({ input, dir, fps, width, format, quality });
  const dims = probe(extracted.first);
  return { fps, count: extracted.count, width: dims.width, height: dims.height, bytes: extracted.bytes };
};

export const framesCommand = async (argv) => {
  const { values, positionals } = parse(argv, OPTIONS);
  const input = positionals[0];
  if (!input) throw new UsageError('a video file is required: frames <video.mp4> [--out <folder>]');
  if (!fs.existsSync(input)) throw new UsageError(`file not found: ${input}`);
  const say = values.json ? () => {} : (line) => console.log(line);
  requireTool('ffmpeg');
  requireTool('ffprobe');

  const quality = values.quality === undefined ? 80 : toNumber(values.quality, 'quality', { integer: true, min: 30, max: 100 });
  const fpsCap = values.fps === undefined ? 12 : toNumber(values.fps, 'fps', { min: 0.5, max: 60 });
  const widthCap = values.width === undefined ? 1280 : toNumber(values.width, 'width', { integer: true, min: 64, max: 4096 });
  const maxFrames = values['max-frames'] === undefined ? 240 : toNumber(values['max-frames'], 'max-frames', { integer: true, min: 2, max: 2000 });
  const format = pickFormat(values.format || 'auto', quality);
  const info = probe(input);

  const dir = path.resolve(values.out || path.join(path.dirname(input), `${path.parse(input).name}-frames`));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (!values.force) throw new UsageError(`folder is not empty: ${rel(dir)} (use --force to recreate it)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const main = buildSet({ input, dir, info, fpsCap, widthCap, maxFrames, format, quality });
  const manifest = {
    version: 1,
    source: path.basename(input),
    duration: Math.round(info.duration * 100) / 100,
    fps: main.fps,
    count: main.count,
    width: main.width,
    height: main.height,
    format,
    start: 1,
    pattern: `frame_%04d.${format}`,
    poster: `frame_0001.${format}`,
    bytes: main.bytes,
  };
  say(`frames: ${main.count} (${main.fps} fps, ${main.width}x${main.height}, ${format}), total ${humanBytes(main.bytes)}`);
  if (main.bytes > HEAVY_BYTES) {
    say(`note: the set is heavy (${humanBytes(main.bytes)}), lower --width or --max-frames`);
  }

  let mobile = null;
  if (values.mobile !== undefined) {
    const mobileWidth = toNumber(values.mobile, 'mobile', { integer: true, min: 64, max: 2048 });
    const mobileMax =
      values['mobile-max-frames'] === undefined ? 120 : toNumber(values['mobile-max-frames'], 'mobile-max-frames', { integer: true, min: 2, max: 2000 });
    mobile = buildSet({
      input,
      dir: path.join(dir, 'mobile'),
      info,
      fpsCap,
      widthCap: mobileWidth,
      maxFrames: mobileMax,
      format,
      quality,
    });
    manifest.mobile = {
      dir: 'mobile',
      fps: mobile.fps,
      count: mobile.count,
      width: mobile.width,
      height: mobile.height,
      start: 1,
      pattern: `frame_%04d.${format}`,
      poster: `frame_0001.${format}`,
      bytes: mobile.bytes,
    };
    say(`mobile set: ${mobile.count} frames, ${mobile.width}x${mobile.height}, total ${humanBytes(mobile.bytes)}`);
  }

  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  say(`manifest: ${rel(manifestFile)}`);
  return finish(values, { ok: true, dir, manifest: manifestFile, format, count: main.count, bytes: main.bytes, mobile: Boolean(mobile) });
};
