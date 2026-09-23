import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';
import { ApiError, UsageError } from './errors.mjs';
import { slug } from './util.mjs';

export const debugFile = () => path.join(dataDir(), 'last-response.json');

export const saveDebug = (data) => {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(debugFile(), JSON.stringify(data, null, 2));
};

export const assertCompleted = (data) => {
  if (data.state && !/^completed?$/i.test(String(data.state))) {
    saveDebug(data);
    const detail = data.error?.message || data.error || '';
    throw new ApiError(`generation did not complete: state=${data.state}${detail ? ` (${detail})` : ''}; raw response saved to ${debugFile()}`);
  }
};

export const rel = (file) => {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
};

const targetPath = ({ out, outDir, label, prompt, key, ext }) => {
  if (!out) return path.resolve(outDir, `${label}-${slug(prompt) || 'gen'}-${key.slice(0, 6)}.${ext}`);
  const resolved = path.resolve(out);
  const parsed = path.parse(resolved);
  const given = parsed.ext.toLowerCase();
  const same = ext === 'jpg' ? given === '.jpg' || given === '.jpeg' : given === `.${ext}`;
  return same ? resolved : path.join(parsed.dir, `${parsed.name}.${ext}`);
};

const refuseExisting = (target) => {
  throw new UsageError(`file already exists: ${rel(target)} (use --force to overwrite)`);
};

export const outputPath = (options) => {
  const target = targetPath(options);
  if (fs.existsSync(target) && !options.force) refuseExisting(target);
  return target;
};

export const writeOutput = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

export const reuseCached = ({ cached, out, label, prompt, key }) => {
  if (!out) return cached;
  const target = targetPath({ out, label, prompt, key, ext: path.extname(cached).slice(1) });
  if (target === path.resolve(cached)) return target;
  const data = fs.readFileSync(cached);
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target).equals(data)) return target;
    refuseExisting(target);
  }
  writeOutput(target, data);
  return target;
};

export const finish = (values, result) => {
  if (values.json) console.log(JSON.stringify(result));
  return result;
};
