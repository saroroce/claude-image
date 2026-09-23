import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/imagegen/scripts/imagegen.mjs', import.meta.url));
const TOKEN = 'good-token';
const ACCOUNT = 'a'.repeat(32);

let mock;
let home;
let work;
let assets;

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

const hasPython = (() => {
  try {
    execFileSync('python3', ['-c', 'import pty']);
    return true;
  } catch {
    return false;
  }
})();

const run = (args, { input, env = {}, cwd } = {}) =>
  new Promise((resolve) => {
    const childEnv = { ...process.env, HOME: home, IMAGEGEN_API_BASE: `${mock.base}/client/v4`, ...env };
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID']) {
      if (!(name in env)) delete childEnv[name];
    }
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv, cwd: cwd || work });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(input ?? '');
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

const ledger = () =>
  fs
    .readFileSync(path.join(home, '.local', 'share', 'imagegen', 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-work-'));
  assets = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-assets-'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'yuvj420p', path.join(assets, 'img.jpg'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1:duration=1', '-frames:v', '1', path.join(assets, 'ref.png'));
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(assets, 'clip.mp4'));
  mock = await startMock({ jpeg: fs.readFileSync(path.join(assets, 'img.jpg')), mp4: fs.readFileSync(path.join(assets, 'clip.mp4')) });
});

after(async () => {
  await mock.close();
});

describe('setup and status', () => {
  it('estimate needs neither credentials nor network', async () => {
    const r = await run(['estimate', 'image', '--tier', 'draft', 'a cat']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /104\.2 neurons/);
    assert.equal(mock.requests.length, 0);
  });

  it('image without credentials exits 2 and points to setup', async () => {
    const r = await run(['image', '--tier', 'draft', 'a cat']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /setup/);
  });

  it('setup rejects a bad token and saves nothing', async () => {
    mock.reset();
    const r = await run(['setup', '--stdin'], { input: `${ACCOUNT}\nbad-token\n` });
    assert.equal(r.code, 5);
    assert.match(r.stderr, /verification failed/);
    assert.equal(fs.existsSync(path.join(home, '.config', 'imagegen', 'env')), false);
    assert.ok(!r.stdout.includes('bad-token') && !r.stderr.includes('bad-token'));
  });

  it('setup stores the key with 0600 and never prints the token', async () => {
    mock.reset();
    const r = await run(['setup', '--stdin', '--add-deny-rule'], { input: `${ACCOUNT}\n${TOKEN}\n` });
    assert.equal(r.code, 0, r.stderr);
    const envFile = path.join(home, '.config', 'imagegen', 'env');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(envFile)).mode & 0o777, 0o700);
    const text = fs.readFileSync(envFile, 'utf8');
    assert.ok(text.includes(`CLOUDFLARE_API_TOKEN=${TOKEN}`));
    assert.ok(text.includes(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`));
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
    const verify = mock.requests.find((req) => req.url.endsWith('/tokens/verify'));
    assert.equal(verify.headers.authorization, `Bearer ${TOKEN}`);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.deny, ['Read(~/.config/imagegen/**)']);
  });

  it('setup adds the deny rule idempotently and keeps existing settings', async () => {
    const file = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'x', permissions: { deny: ['Read(./.env)'] } }));
    const r = await run(['setup', '--stdin', '--add-deny-rule'], { input: `${ACCOUNT}\n${TOKEN}\n` });
    assert.equal(r.code, 0, r.stderr);
    await run(['setup', '--stdin', '--add-deny-rule'], { input: `${ACCOUNT}\n${TOKEN}\n` });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(settings.model, 'x');
    assert.deepEqual(settings.permissions.deny, ['Read(./.env)', 'Read(~/.config/imagegen/**)']);
    assert.ok(fs.existsSync(`${file}.imagegen.bak`));
  });

  it('setup refuses to touch an unparsable settings.json', async () => {
    const file = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(file, '{ not json');
    const r = await run(['setup', '--stdin', '--add-deny-rule'], { input: `${ACCOUNT}\n${TOKEN}\n` });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    fs.rmSync(file);
    fs.rmSync(`${file}.imagegen.bak`, { force: true });
  });

  it('status masks the token and --check verifies it', async () => {
    const r = await run(['status', '--check']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /…oken/);
    assert.match(r.stdout, /token is active/);
    assert.ok(!r.stdout.includes(TOKEN));
  });

  it('environment variables override the file', async () => {
    const r = await run(['status'], { env: { CLOUDFLARE_API_TOKEN: 'other-token-1234', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) } });
    assert.match(r.stdout, /environment variables/);
    assert.match(r.stdout, /…1234/);
  });

  it('interactive setup hides the token (pty)', { skip: !hasPython }, async () => {
    const ptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-pty-'));
    const childEnv = { ...process.env, HOME: ptyHome, IMAGEGEN_API_BASE: `${mock.base}/client/v4` };
    const driver = fileURLToPath(new URL('./pty-driver.py', import.meta.url));
    const result = await new Promise((resolve) => {
      const child = spawn('python3', [driver, ACCOUNT, TOKEN, process.execPath, SCRIPT, 'setup', '--no-deny-rule'], { env: childEnv, cwd: work });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Token is active/);
    assert.ok(!result.out.includes(TOKEN), 'token must not be echoed by the terminal');
    assert.ok(result.out.includes(ACCOUNT), 'the account id is visible while typing');
    const saved = fs.readFileSync(path.join(ptyHome, '.config', 'imagegen', 'env'), 'utf8');
    assert.ok(saved.includes(`CLOUDFLARE_API_TOKEN=${TOKEN}`));
    fs.rmSync(ptyHome, { recursive: true, force: true });
  });
});

describe('image', () => {
  it('draft goes to the native multipart endpoint, saves the file and the ledger entry', async () => {
    mock.reset();
    const r = await run(['image', '--tier', 'draft', '--out', 'out/fox', 'a red fox']);
    assert.equal(r.code, 0, r.stderr);
    const [req] = mock.apiRequests();
    assert.equal(req.url, `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
    const body = req.body.toString('latin1');
    assert.match(body, /name="prompt"\r\n\r\na red fox/);
    assert.match(body, /name="width"\r\n\r\n1024/);
    assert.match(body, /name="height"\r\n\r\n1024/);
    const file = path.join(work, 'out', 'fox.jpg');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(file)[0], 0xff);
    const entry = ledger().at(-1);
    assert.equal(entry.cmd, 'image');
    assert.equal(entry.neurons, 104.2);
    assert.equal(entry.est_usd, 0);
  });

  it('the same request is served from the cache without a new API call', async () => {
    mock.reset();
    const r = await run(['image', '--tier', 'draft', '--out', 'out/fox', 'a red fox']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /served from cache/);
    assert.equal(mock.apiRequests().length, 0);
  });

  it('a cache hit is copied to a different --out and refuses to clobber another file', async () => {
    mock.reset();
    const copied = await run(['image', '--tier', 'draft', '--out', 'out/fox-copy', 'a red fox']);
    assert.equal(copied.code, 0, copied.stderr);
    assert.equal(mock.apiRequests().length, 0);
    assert.ok(fs.existsSync(path.join(work, 'out', 'fox-copy.jpg')));
    const clobber = await run(['image', '--tier', 'draft', '--out', 'out/fox-copy', 'a red fox']);
    assert.equal(clobber.code, 0, 'same target is the cached copy or original, both fine');
    fs.writeFileSync(path.join(work, 'out', 'taken.jpg'), 'x');
    const refused = await run(['image', '--tier', 'draft', '--out', 'out/taken', 'a red fox']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists/);
  });

  it('--force ignores the cache and overwrites', async () => {
    mock.reset();
    const r = await run(['image', '--tier', 'draft', '--out', 'out/fox', '--force', 'a red fox']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.apiRequests().length, 1);
  });

  it('an existing --out file is protected for a different request', async () => {
    const r = await run(['image', '--tier', 'draft', '--out', 'out/fox', 'a blue fox']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
  });

  it('final uses the unified JSON endpoint and downloads the result URL', async () => {
    mock.reset();
    const r = await run(['image', '--tier', 'final', '--aspect', '16:9', '--format', 'webp', '--seed', '7', '--json', 'hero banner']);
    assert.equal(r.code, 0, r.stderr);
    const [req] = mock.apiRequests();
    assert.equal(req.url, `/client/v4/accounts/${ACCOUNT}/ai/run`);
    const payload = JSON.parse(req.body.toString('utf8'));
    assert.equal(payload.model, 'black-forest-labs/flux-2-pro-preview');
    assert.deepEqual(payload.input, { prompt: 'hero banner', width: 1360, height: 768, seed: 7, output_format: 'webp' });
    const result = JSON.parse(r.stdout.trim());
    assert.equal(result.ok, true);
    assert.equal(result.est_usd, 0.03);
    assert.ok(fs.existsSync(result.file));
    assert.equal(mock.requests.at(-1).headers.authorization, undefined, 'token must not be sent to the file host');
  });

  it('flex passes steps and guidance, pro ignores them with a note', async () => {
    mock.reset();
    const flex = await run(['image', '--tier', 'text', '--steps', '30', '--guidance', '4', 'poster with text']);
    assert.equal(flex.code, 0, flex.stderr);
    assert.deepEqual(JSON.parse(mock.apiRequests()[0].body.toString('utf8')).input.steps, 30);
    assert.deepEqual(JSON.parse(mock.apiRequests()[0].body.toString('utf8')).input.guidance, 4);
    mock.reset();
    const pro = await run(['image', '--tier', 'final', '--steps', '30', 'plain photo']);
    assert.match(pro.stdout, /--steps is not supported/);
    assert.equal(JSON.parse(mock.apiRequests()[0].body.toString('utf8')).input.steps, undefined);
  });

  it('local references become data URIs for unified models and files for multipart models', async () => {
    mock.reset();
    const ref = path.join(assets, 'ref.png');
    const pro = await run(['image', '--tier', 'final', '--ref', ref, 'restyle this']);
    assert.equal(pro.code, 0, pro.stderr);
    const input = JSON.parse(mock.apiRequests()[0].body.toString('utf8')).input;
    assert.match(input.input_images[0], /^data:image\/png;base64,/);
    mock.reset();
    const klein = await run(['image', '--tier', 'draft', '--ref', ref, 'restyle this too']);
    assert.equal(klein.code, 0, klein.stderr);
    const body = mock.apiRequests()[0].body.toString('latin1');
    assert.match(body, /name="input_image_0"; filename="ref0\.png"/);
  });

  it('too many references are rejected before any request', async () => {
    mock.reset();
    const ref = path.join(assets, 'ref.png');
    const args = ['image', '--tier', 'draft', 'x'];
    for (let i = 0; i < 5; i += 1) args.push('--ref', ref);
    const r = await run(args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /up to 4/);
    assert.equal(mock.apiRequests().length, 0);
  });

  it('schnell uses the JSON native endpoint with default steps', async () => {
    mock.reset();
    const r = await run(['image', '--model', 'schnell', 'quick sketch']);
    assert.equal(r.code, 0, r.stderr);
    const [req] = mock.apiRequests();
    assert.equal(req.url, `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`);
    assert.deepEqual(JSON.parse(req.body.toString('utf8')), { prompt: 'quick sketch', steps: 4 });
  });

  it('sizes are rounded to multiples of 16 and capped at 4 MP', async () => {
    const rounded = await run(['estimate', 'image', '--tier', 'draft', '--size', '1000x700', 'x']);
    assert.match(rounded.stdout, /size: 1008x704/);
    const huge = await run(['estimate', 'image', '--tier', 'draft', '--size', '3000x3000', 'x']);
    assert.equal(huge.code, 1);
    assert.match(huge.stderr, /above 4 MP/);
  });

  it('a prompt can come from a file', async () => {
    fs.writeFileSync(path.join(work, 'prompt.txt'), 'prompt from file\n');
    mock.reset();
    const r = await run(['image', '--tier', 'draft', '--prompt-file', 'prompt.txt']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(mock.apiRequests()[0].body.toString('latin1'), /prompt from file/);
  });
});

describe('spend guards', () => {
  it('an expensive request needs --yes and is charged to the ledger', async () => {
    mock.reset();
    const blocked = await run(['image', '--tier', 'hero', '--mp', '4', 'huge poster']);
    assert.equal(blocked.code, 3);
    assert.match(blocked.stderr, /confirmation needed/);
    assert.equal(mock.apiRequests().length, 0);
    const ok = await run(['image', '--tier', 'hero', '--mp', '4', '--yes', 'huge poster']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ledger().at(-1).est_usd, 0.28);
  });

  it('the monthly budget blocks even with --yes until overridden', async () => {
    await run(['config', 'set', 'monthlyBudgetUsd', '0.05']);
    mock.reset();
    const blocked = await run(['image', '--tier', 'final', '--yes', 'over budget']);
    assert.equal(blocked.code, 4);
    assert.match(blocked.stderr, /budget/);
    assert.equal(mock.apiRequests().length, 0);
    const forced = await run(['image', '--tier', 'final', '--yes', '--override-budget', 'over budget']);
    assert.equal(forced.code, 0, forced.stderr);
    await run(['config', 'unset', 'monthlyBudgetUsd']);
  });

  it('free neurons run out and the overflow is priced', async () => {
    await run(['config', 'set', 'dailyFreeNeurons', '50']);
    const r = await run(['estimate', 'image', '--tier', 'draft', 'x']);
    assert.match(r.stdout, /over the free allowance/);
    await run(['config', 'unset', 'dailyFreeNeurons']);
  });

  it('config validates keys and numbers', async () => {
    const badKey = await run(['config', 'set', 'nope', '1']);
    assert.equal(badKey.code, 1);
    const badNumber = await run(['config', 'set', 'monthlyBudgetUsd', 'abc']);
    assert.equal(badNumber.code, 1);
    const prices = await run(['config', 'set', 'prices.pro.first', '0.05']);
    assert.equal(prices.code, 0);
    const est = await run(['estimate', 'image', '--tier', 'final', 'x']);
    assert.match(est.stdout, /≈ \$0\.050/);
    await run(['config', 'unset', 'prices.pro.first']);
  });
});

describe('errors', () => {
  it('a 401 gives a useful message and never leaks the token', async () => {
    mock.reset();
    mock.setMode('unauthorized');
    const r = await run(['image', '--tier', 'final', 'x401']);
    mock.setMode('ok');
    assert.equal(r.code, 5);
    assert.match(r.stderr, /HTTP 401/);
    assert.match(r.stderr, /Read and Edit/);
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
  });

  it('exhausted free quota is explained', async () => {
    mock.reset();
    mock.setMode('quota');
    const r = await run(['image', '--tier', 'draft', 'xquota']);
    mock.setMode('ok');
    assert.equal(r.code, 5);
    assert.match(r.stderr, /free Workers AI allowance/);
  });

  it('a Failed state surfaces as an error and keeps the raw response', async () => {
    mock.reset();
    mock.setMode('failed');
    const r = await run(['image', '--tier', 'final', 'xfail']);
    mock.setMode('ok');
    assert.equal(r.code, 5);
    assert.match(r.stderr, /state=Failed/);
    assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'imagegen', 'last-response.json')));
  });
});

describe('video', () => {
  it('always needs --yes and shows the price', async () => {
    mock.reset();
    const blocked = await run(['video', 'a phone rotating']);
    assert.equal(blocked.code, 3);
    assert.match(blocked.stderr, /video always requires confirmation/);
    const dry = await run(['video', '--yes', '--dry-run', 'a phone rotating']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /≈ \$0\.85/);
    assert.equal(mock.apiRequests().length, 0);
  });

  it('t2v sends the documented input and stores an mp4', async () => {
    mock.reset();
    const r = await run(['video', '--yes', '--out', 'clips/phone', '--json', 'a phone rotating']);
    assert.equal(r.code, 0, r.stderr);
    const payload = JSON.parse(mock.apiRequests()[0].body.toString('utf8'));
    assert.equal(payload.model, 'black-forest-labs/flux-3-video');
    assert.deepEqual(payload.input, {
      mode: 't2v',
      prompt: 'a phone rotating',
      resolution: 'hd',
      duration: 5,
      generate_audio: false,
      aspect_ratio: '16:9',
    });
    const file = path.join(work, 'clips', 'phone.mp4');
    assert.equal(fs.readFileSync(file).toString('ascii', 4, 8), 'ftyp');
    assert.equal(JSON.parse(r.stdout.trim()).est_usd, 0.85);
  });

  it('draft mode is cheaper and flagged in the request', async () => {
    mock.reset();
    const r = await run(['video', '--yes', '--draft', 'draft phone']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(mock.apiRequests()[0].body.toString('utf8')).input.draft, true);
    assert.equal(ledger().at(-1).est_usd, 0.3);
    assert.ok(ledger().at(-1).draft_cache);
  });

  it('i2v turns local images into keyframes', async () => {
    mock.reset();
    const r = await run(['video', '--yes', '--duration', '8', '--image', path.join(assets, 'ref.png'), 'animate the phone']);
    assert.equal(r.code, 0, r.stderr);
    const input = JSON.parse(mock.apiRequests()[0].body.toString('utf8')).input;
    assert.equal(input.mode, 'i2v');
    assert.equal(input.aspect_ratio, 'auto');
    assert.equal(input.duration, 8);
    assert.match(input.keyframes[0], /^data:image\/png;base64,/);
  });

  it('validates duration, mode combinations and draft resolution', async () => {
    assert.equal((await run(['video', '--yes', '--duration', '4', 'x'])).code, 1);
    assert.equal((await run(['video', '--yes', '--duration', '21', 'x'])).code, 1);
    assert.equal((await run(['video', '--yes', '--mode', 'v2v', 'x'])).code, 1);
    assert.equal((await run(['video', '--yes', '--draft', '--res', 'fhd', 'x'])).code, 1);
    assert.equal((await run(['video', '--yes', '--mode', 't2v', '--image', path.join(assets, 'ref.png'), 'x'])).code, 1);
  });

  it('a repeated video request is served from the cache', async () => {
    mock.reset();
    const r = await run(['video', '--yes', '--out', 'clips/phone2', 'a phone rotating']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /served from cache/);
    assert.equal(mock.apiRequests().length, 0);
  });
});

describe('frames', () => {
  it('cuts a clip into numbered frames with a manifest and a mobile set', async () => {
    const clip = path.join(assets, 'clip.mp4');
    const r = await run(['frames', clip, '--out', 'frames', '--fps', '6', '--width', '160', '--mobile', '96', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout.trim());
    assert.ok(['jpg', 'webp'].includes(result.format));
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'frames', 'manifest.json'), 'utf8'));
    assert.equal(manifest.count, 12);
    assert.equal(manifest.width, 160);
    assert.equal(manifest.height, 90);
    assert.equal(manifest.pattern, `frame_%04d.${result.format}`);
    assert.ok(fs.existsSync(path.join(work, 'frames', `frame_0012.${result.format}`)));
    assert.equal(manifest.mobile.width, 96);
    assert.ok(fs.existsSync(path.join(work, 'frames', 'mobile', manifest.mobile.poster)));
  });

  it('--max-frames lowers the fps to fit the budget', async () => {
    const clip = path.join(assets, 'clip.mp4');
    const r = await run(['frames', clip, '--out', 'frames-small', '--fps', '24', '--max-frames', '10', '--width', '160', '--format', 'jpg', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(work, 'frames-small', 'manifest.json'), 'utf8'));
    assert.ok(manifest.count <= 11, `count ${manifest.count}`);
  });

  it('refuses a non-empty folder without --force', async () => {
    const clip = path.join(assets, 'clip.mp4');
    const r = await run(['frames', clip, '--out', 'frames', '--fps', '6']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /folder is not empty/);
  });
});

describe('aliases and auto-detect', () => {
  it('photo is an alias for image', async () => {
    mock.reset();
    const r = await run(['photo', '--tier', 'draft', '--out', 'out/alias-photo', 'a lemon']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.apiRequests()[0].url, `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
  });

  it('install is an alias for setup', async () => {
    const r = await run(['install', '--stdin'], { input: `${ACCOUNT}\n${TOKEN}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Token is active/);
  });

  it('a bare prompt with no command auto-picks the image draft tier', async () => {
    mock.reset();
    const r = await run(['unmatched command a lemon portrait']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.apiRequests()[0].url, `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
    const entry = ledger().at(-1);
    assert.equal(entry.cmd, 'image');
    assert.match(entry.prompt, /unmatched command a lemon portrait/);
  });

  it('a bare prompt mentioning video routes to the video command and still needs --yes', async () => {
    mock.reset();
    const blocked = await run(['make a video of a lemon spinning']);
    assert.equal(blocked.code, 3);
    assert.match(blocked.stderr, /video always requires confirmation/);
    assert.equal(mock.apiRequests().length, 0);
    const ok = await run(['сделай видео с лимоном', '--yes']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(mock.apiRequests()[0].body.toString('utf8')).model, 'black-forest-labs/flux-3-video');
  });

  it('an all-flags line with no text is a usage error, not a silent call', async () => {
    mock.reset();
    const r = await run(['--bogus-flag']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command/);
    assert.equal(mock.apiRequests().length, 0);
  });
});

describe('published text', () => {
  const skill = fs.readFileSync(new URL('../skills/imagegen/SKILL.md', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const cyrillic = (text) => text.split('\n').filter((line) => /[А-Яа-яЁё]/.test(line));

  it('SKILL.md has frontmatter with a name and a description', () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    assert.ok(match, 'frontmatter missing');
    assert.match(match[1], /^name: imagegen$/m);
    assert.match(match[1], /^description: .{40,}/m);
  });

  it('SKILL.md has no dollar-digit sequences that slash-command arguments would replace', () => {
    assert.ok(!/\$\d/.test(skill), 'a dollar sign followed by a digit is substituted by the first argument');
  });

  it('SKILL.md and README are English apart from the translation examples', () => {
    assert.deepEqual(cyrillic(skill).filter((line) => !line.startsWith('Translations of these words')), []);
    assert.deepEqual(cyrillic(readme), []);
  });

  it('every image the README references exists', () => {
    const images = [...readme.matchAll(/\(docs\/([\w-]+\.(?:jpg|png))\)|src="docs\/([\w-]+\.(?:jpg|png))"/g)].map((m) => m[1] || m[2]);
    assert.ok(images.length >= 6, `found ${images.length} images`);
    for (const name of images) assert.ok(fs.existsSync(new URL(`../docs/${name}`, import.meta.url)), name);
  });
});

describe('secrets hygiene', () => {
  it('the token appears nowhere except the env file', async () => {
    const envFile = path.join(home, '.config', 'imagegen', 'env');
    const leaked = [...walk(home), ...walk(work)].filter((file) => file !== envFile).filter((file) => fs.readFileSync(file).includes(TOKEN));
    assert.deepEqual(leaked, []);
  });
});
