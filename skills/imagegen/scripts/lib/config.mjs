import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.mjs';

export const DEFAULTS = {
  confirmAboveUsd: 0.1,
  monthlyBudgetUsd: 15,
  dailyFreeNeurons: 10000,
  outDir: 'generated',
};

const NAMES = {
  accountId: ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'],
  token: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
};

export const configDir = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'imagegen');
export const dataDir = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'imagegen');
export const envFile = () => path.join(configDir(), 'env');
export const configFile = () => path.join(configDir(), 'config.json');
export const ledgerFile = () => path.join(dataDir(), 'ledger.jsonl');
export const scriptPath = () => fileURLToPath(new URL('../imagegen.mjs', import.meta.url));
export const apiBase = () =>
  (process.env.IMAGEGEN_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

const parseEnv = (text) => {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = /^(["']).*\1$/.test(value);
    if (quoted) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
};

const lookup = (names, bag) => names.map((name) => bag[name]).find(Boolean);

export const loadCredentials = () => {
  const fileValues = fs.existsSync(envFile()) ? parseEnv(fs.readFileSync(envFile(), 'utf8')) : {};
  const accountId = lookup(NAMES.accountId, process.env) || lookup(NAMES.accountId, fileValues);
  const token = lookup(NAMES.token, process.env) || lookup(NAMES.token, fileValues);
  if (!accountId || !token) return null;
  const fromEnv = Boolean(lookup(NAMES.token, process.env));
  return { accountId, token, source: fromEnv ? 'environment' : envFile() };
};

export const requireCredentials = () => {
  const creds = loadCredentials();
  if (creds) return creds;
  throw new ConfigError(
    `no Cloudflare key. In Claude Code run /imagegen install (the wizard opens in the terminal panel next to the chat). Without Claude: node "${scriptPath()}" setup. Never paste the token into a chat`,
  );
};

export const saveCredentials = ({ accountId, token }) => {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${envFile()}.tmp`;
  fs.writeFileSync(tmp, `CLOUDFLARE_ACCOUNT_ID=${accountId}\nCLOUDFLARE_API_TOKEN=${token}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, envFile());
};

export const maskToken = (token) => (token.length > 8 ? `…${token.slice(-4)}` : '****');

export const permissionsWarning = () => {
  if (!fs.existsSync(envFile())) return null;
  const mode = fs.statSync(envFile()).mode & 0o777;
  if (mode & 0o077) {
    return `${envFile()} has mode ${mode.toString(8)}, wider than 600; run: chmod 600 "${envFile()}"`;
  }
  return null;
};

export const readUserConfig = () => {
  if (!fs.existsSync(configFile())) return {};
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    throw new ConfigError(`cannot parse ${configFile()}: invalid JSON`);
  }
};

export const writeUserConfig = (user) => {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), `${JSON.stringify(user, null, 2)}\n`);
};

export const loadConfig = () => {
  const user = readUserConfig();
  return { ...DEFAULTS, ...user, prices: user.prices || {} };
};
