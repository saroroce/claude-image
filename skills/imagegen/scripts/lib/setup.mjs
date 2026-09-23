import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parse } from './args.mjs';
import {
  apiBase,
  configDir,
  envFile,
  loadConfig,
  loadCredentials,
  maskToken,
  permissionsWarning,
  saveCredentials,
} from './config.mjs';
import { readLedger, summarize } from './cost.mjs';
import { ApiError, ConfigError } from './errors.mjs';
import { rawRequest } from './http.mjs';

const BOOLEAN = { type: 'boolean' };

export const verifyToken = async (accountId, token) => {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const urls = [`${apiBase()}/user/tokens/verify`, `${apiBase()}/accounts/${accountId}/tokens/verify`];
  let failure = { message: 'no response' };
  for (const url of urls) {
    try {
      const res = await rawRequest(url, { headers, timeoutMs: 20000 });
      let data = null;
      try {
        data = JSON.parse(res.body.toString('utf8'));
      } catch {
        data = null;
      }
      if (res.status === 200 && data?.success && data.result?.status === 'active') return { ok: true };
      failure = { message: data?.errors?.[0]?.message || `HTTP ${res.status}` };
    } catch (err) {
      failure = { message: err.message };
    }
  }
  return { ok: false, ...failure };
};

const readAll = (stream) =>
  new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
    });
    stream.on('end', () => resolve(text));
  });

const ask = (prompt) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const askHidden = (prompt) =>
  new Promise((resolve) => {
    process.stdout.write(prompt);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.replace(/\[[0-9;]*[~A-Za-z]/g, '').trim());
          return;
        }
        if (ch === '') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });

const denyRule = () => {
  const relative = path.relative(os.homedir(), configDir());
  if (relative.startsWith('..') || path.isAbsolute(relative)) return `Read(/${configDir()}/**)`;
  return `Read(~/${relative.split(path.sep).join('/')}/**)`;
};

const addDenyRule = () => {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const rule = denyRule();
  let settings = {};
  const existed = fs.existsSync(file);
  if (existed) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { ok: false, rule, reason: `${file} is not valid JSON, left untouched` };
    }
  }
  settings.permissions = settings.permissions || {};
  if (settings.permissions.deny !== undefined && !Array.isArray(settings.permissions.deny)) {
    return { ok: false, rule, reason: 'permissions.deny is not an array, left untouched' };
  }
  settings.permissions.deny = settings.permissions.deny || [];
  if (settings.permissions.deny.includes(rule)) return { ok: true, rule, file, already: true };
  if (existed && !fs.existsSync(`${file}.imagegen.bak`)) fs.copyFileSync(file, `${file}.imagegen.bak`);
  settings.permissions.deny.push(rule);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { ok: true, rule, file, backup: existed ? `${file}.imagegen.bak` : null };
};

export const setupCommand = async (argv) => {
  const { values } = parse(
    argv,
    { stdin: BOOLEAN, 'no-verify': BOOLEAN, 'add-deny-rule': BOOLEAN, 'no-deny-rule': BOOLEAN },
    false,
  );
  let accountId;
  let token;
  if (values.stdin) {
    [accountId, token] = (await readAll(process.stdin)).split('\n').map((line) => line.trim()).filter(Boolean);
  } else {
    if (!process.stdin.isTTY) throw new ConfigError('an interactive terminal is required (or pass --stdin to read the key from stdin)');
    console.log('Cloudflare key for imagegen\n');
    console.log('Step 1. Create a token and copy your Account ID:');
    console.log('  https://dash.cloudflare.com/?to=/:account/ai/workers-ai');
    console.log('  Use REST API → Create a Workers AI API Token → Create API Token → Copy API Token');
    console.log('  The Account ID is on the same page.');
    console.log('  Manual route: https://dash.cloudflare.com/profile/api-tokens → Custom token, Account / Workers AI: Read and Edit.');
    console.log('  Never use the Global API Key: it opens the whole account.');
    console.log('Step 2. Paste the Account ID below, then the token (input is hidden).');
    console.log('Paid models and video need credits: https://dash.cloudflare.com/?to=/:account/ai/ai-gateway → Credits Available → Manage → Top-up credits');
    console.log(`\nThe key is stored only in ${envFile()} (mode 600).\n`);
    accountId = await ask('Account ID: ');
    token = await askHidden('API token (input hidden): ');
  }
  if (!accountId || !token) throw new ConfigError('both the Account ID and the token are required');
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    console.log('note: an Account ID is usually 32 hex characters, check that you copied the right value');
  }

  if (!values['no-verify']) {
    console.log('Verifying the token…');
    const check = await verifyToken(accountId, token);
    if (!check.ok) throw new ApiError(`token verification failed: ${check.message}. Nothing was saved (use --no-verify to save without checking)`);
    console.log('Token is active.');
  }

  saveCredentials({ accountId, token });
  console.log(`Saved: ${envFile()} (token ${maskToken(token)}, mode 600)`);

  const rule = denyRule();
  let add = false;
  if (values['add-deny-rule']) add = true;
  else if (!values['no-deny-rule'] && !values.stdin && process.stdin.isTTY) {
    const answer = await ask(`\nBlock Claude from reading this file (rule ${rule} in ~/.claude/settings.json)? [Y/n] `);
    add = answer === '' || /^y/i.test(answer);
  }
  if (add) {
    const result = addDenyRule();
    if (!result.ok) console.log(`Rule not added: ${result.reason}. Add it manually under permissions.deny: "${result.rule}"`);
    else if (result.already) console.log('The read-deny rule is already in settings.json.');
    else console.log(`Rule ${result.rule} added to ${result.file}${result.backup ? ` (backup: ${result.backup})` : ''}.`);
  } else {
    console.log(`\nTip: add the rule "${rule}" under permissions.deny in ~/.claude/settings.json so Claude cannot read the key.`);
  }
  console.log('\nDone. Verify with: status --check');
};

export const statusCommand = async (argv) => {
  const { values } = parse(argv, { check: BOOLEAN }, false);
  const creds = loadCredentials();
  const cfg = loadConfig();
  const summary = summarize(readLedger());
  if (!creds) {
    console.log('key: not configured. In Claude Code run /imagegen install (or node imagegen.mjs setup in your own terminal)');
  } else {
    console.log(`key: ${creds.source === 'environment' ? 'environment variables' : creds.source}, token ${maskToken(creds.token)}, Account ID ${creds.accountId.slice(0, 4)}…`);
    const warning = permissionsWarning();
    if (warning) console.log(`note: ${warning}`);
    if (values.check) {
      const check = await verifyToken(creds.accountId, creds.token);
      console.log(check.ok ? 'token is active' : `token verification failed: ${check.message}`);
      if (!check.ok) throw new ApiError('token verification failed');
    }
  }
  const left = Math.max(0, cfg.dailyFreeNeurons - summary.todayNeurons);
  console.log(`today (UTC): ${summary.todayCount} requests, ${summary.todayNeurons} neurons, free allowance left ≈ ${left} of ${cfg.dailyFreeNeurons}`);
  console.log(`month: ${summary.monthCount} requests, ≈ $${summary.monthUsd.toFixed(2)} of the $${cfg.monthlyBudgetUsd} budget`);
  console.log(`confirmation threshold: $${cfg.confirmAboveUsd}, default folder: ${cfg.outDir}`);
};
