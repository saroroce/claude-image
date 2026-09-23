import { framesCommand } from './frames.mjs';
import { imageCommand } from './image.mjs';
import { DEFAULTS, loadConfig, readUserConfig, writeUserConfig } from './config.mjs';
import { readLedger, summarize } from './cost.mjs';
import { UsageError } from './errors.mjs';
import { MODELS, NEURON_USD, TIERS, VIDEO } from './models.mjs';
import { setupCommand, statusCommand } from './setup.mjs';
import { videoCommand } from './video.mjs';

const HELP = `imagegen: FLUX images and video through Cloudflare Workers AI

  setup, install                  save the Cloudflare key (interactive, run by the user)
  status [--check]                key, budget, free allowance
  models                          models, tiers and prices
  usage                           spend ledger
  config [set|unset key value]    limits and prices
  estimate image|video ...        price estimate only: no request, no key needed
  image, photo "prompt" [--tier draft|final|text|hero] [--model klein-4b|klein-9b|schnell|pro|flex|max]
        [--aspect 16:9] [--mp 1] [--size 1360x768] [--ref file|url]... [--seed N] [--steps N]
        [--guidance X] [--format jpeg|png|webp] [--out file] [--out-dir folder] [--yes] [--force]
  video "prompt" [--duration 5..20] [--res hd|fhd] [--draft] [--audio] [--aspect 16:9]
        [--image file|url]... [--video https-link] [--out file] --yes
  frames video.mp4 [--out folder] [--fps 12] [--width 1280] [--max-frames 240]
        [--format auto|webp|jpg] [--quality 80] [--mobile 640] [--mobile-max-frames 120]

  "text without a command"        guesses photo or video from words like video, видео, ролик, клип, анимация;
                                  defaults to a photo on the free draft tier, video still asks for --yes

Common flags: --dry-run, --json, --prompt-file <file>, --override-budget, --timeout <seconds>`;

const modelsCommand = () => {
  console.log('tiers:');
  for (const [tier, key] of Object.entries(TIERS)) console.log(`  ${tier} -> ${key}`);
  console.log('\nmodels:');
  for (const [key, model] of Object.entries(MODELS)) {
    const pricing = model.pricing;
    const price =
      pricing.kind === 'usd-mp'
        ? `from $${pricing.first} per MP (editing from $${pricing.edit}), via Unified Billing`
        : 'Workers AI neurons, free daily allowance';
    console.log(`  ${key.padEnd(9)} ${model.id}  [${model.transport}, up to ${model.maxRefs} references]  ${price}`);
  }
  const rates = VIDEO.perSecond;
  console.log(`\nvideo: ${VIDEO.id}, $/s: t2v and i2v hd ${rates.t2v.hd}, fhd ${rates.t2v.fhd}, draft ${rates.t2v.draft}; v2v hd ${rates.v2v.hd}, fhd ${rates.v2v.fhd}, draft ${rates.v2v.draft}`);
  console.log(`neuron = $${(NEURON_USD * 1000).toFixed(3)} per 1000; prices of third-party models and video come from the BFL price list, check the Cloudflare dashboard for current ones (config set prices.pro.first 0.03)`);
};

const usageCommand = () => {
  const cfg = loadConfig();
  const entries = readLedger();
  const summary = summarize(entries);
  const left = Math.max(0, cfg.dailyFreeNeurons - summary.todayNeurons);
  console.log(`today (UTC): ${summary.todayCount} requests, ${summary.todayNeurons} neurons, free allowance left ≈ ${left}, ≈ $${summary.todayUsd.toFixed(3)}`);
  console.log(`month ${summary.month}: ${summary.monthCount} requests, ≈ $${summary.monthUsd.toFixed(2)} of $${cfg.monthlyBudgetUsd}`);
  console.log('recent:');
  for (const entry of entries.slice(-8)) {
    console.log(`  ${entry.ts.slice(0, 19)}  ${entry.cmd} ${entry.tier}  ≈ $${(entry.est_usd || 0).toFixed(3)}  ${entry.neurons || 0} neurons  ${entry.file || ''}`);
  }
  console.log('these are estimates from the local ledger; exact figures are in the Cloudflare dashboard');
};

const NUMERIC_KEYS = ['confirmAboveUsd', 'monthlyBudgetUsd', 'dailyFreeNeurons'];

const configCommand = (argv) => {
  const [action, key, value] = argv;
  if (!action) {
    console.log(JSON.stringify({ ...loadConfig(), defaults: DEFAULTS }, null, 2));
    return;
  }
  if (!['set', 'unset'].includes(action) || !key) throw new UsageError('config [set key value | unset key]');
  const path = key.split('.');
  const root = path[0];
  if (![...NUMERIC_KEYS, 'outDir', 'prices'].includes(root)) {
    throw new UsageError(`unknown key ${root}. Available: ${[...NUMERIC_KEYS, 'outDir', 'prices.<model>.<field>'].join(', ')}`);
  }
  const user = readUserConfig();
  let target = user;
  for (const part of path.slice(0, -1)) {
    target[part] = target[part] && typeof target[part] === 'object' ? target[part] : {};
    target = target[part];
  }
  const leaf = path[path.length - 1];
  if (action === 'unset') {
    delete target[leaf];
  } else {
    if (value === undefined) throw new UsageError('config set key value');
    const numeric = root !== 'outDir';
    const parsed = numeric ? Number(value) : value;
    if (numeric && !Number.isFinite(parsed)) throw new UsageError(`${key}: expected a number`);
    target[leaf] = parsed;
  }
  writeUserConfig(user);
  console.log(`${action}: ${key}${action === 'set' ? ` = ${value}` : ''}`);
};

const VIDEO_HINTS = ['video', 'видео', 'ролик', 'клип', 'анимац', 'motion'];

const looksLikeVideo = (text) => {
  const lower = text.toLowerCase();
  return VIDEO_HINTS.some((hint) => lower.includes(hint));
};

const autoCommand = (argv) => {
  const text = argv.filter((arg) => !arg.startsWith('-')).join(' ').trim();
  if (!text) throw new UsageError(`unknown command: ${argv[0]}. Run help for the list of commands`);
  return looksLikeVideo(text) ? videoCommand(argv) : imageCommand(argv);
};

export const main = async (argv) => {
  const [command, ...rest] = argv;
  switch (command) {
    case 'setup':
    case 'install':
      return setupCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'models':
      return modelsCommand();
    case 'usage':
      return usageCommand();
    case 'config':
      return configCommand(rest);
    case 'image':
    case 'photo':
      return imageCommand(rest);
    case 'video':
      return videoCommand(rest);
    case 'frames':
      return framesCommand(rest);
    case 'estimate': {
      const [kind, ...more] = rest;
      if (kind === 'image' || kind === 'photo') return imageCommand(more, { dryRun: true });
      if (kind === 'video') return videoCommand(more, { dryRun: true });
      throw new UsageError('estimate image|video ...');
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return undefined;
    default:
      return autoCommand(argv);
  }
};
