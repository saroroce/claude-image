import crypto from 'node:crypto';
import { UsageError } from './errors.mjs';

export const MP = 1048576;

export const sha256 = (...parts) => {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

export const round = (value, digits = 4) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

export const slug = (text, max = 32) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');

export const sniffImage = (buf) => {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length > 8 && buf.subarray(0, 8).equals(png)) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
};

export const sniffMp4 = (buf) => buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp';

export const humanBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < MP) return `${Math.round(n / 1024)} KB`;
  return `${(n / MP).toFixed(1)} MB`;
};

export const toNumber = (text, name, { min = -Infinity, max = Infinity, integer = false } = {}) => {
  const value = Number(text);
  const bad = !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value));
  if (bad) {
    const bounded = Number.isFinite(min) || Number.isFinite(max);
    const range = bounded ? ` in the range ${min}..${max}` : '';
    throw new UsageError(`--${name}: expected ${integer ? 'an integer' : 'a number'}${range}, got "${text}"`);
  }
  return value;
};

export const roundTo16 = (n) => Math.max(64, Math.round(n / 16) * 16);

export const parseAspect = (text) => {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text);
  if (!m || Number(m[2]) === 0) {
    throw new UsageError(`--aspect: expected a format like 16:9, got "${text}"`);
  }
  return Number(m[1]) / Number(m[2]);
};

export const dimsFromAspect = (aspect, mp) => {
  const ratio = parseAspect(aspect);
  const width = Math.sqrt(mp * MP * ratio);
  return { width: roundTo16(width), height: roundTo16(width / ratio) };
};

export const parseSize = (text) => {
  const m = /^(\d+)x(\d+)$/i.exec(text);
  if (!m) throw new UsageError(`--size: expected a format like 1024x768, got "${text}"`);
  return { width: roundTo16(Number(m[1])), height: roundTo16(Number(m[2])) };
};
