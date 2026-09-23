import fs from 'node:fs';
import { dataDir, ledgerFile } from './config.mjs';
import { GuardError } from './errors.mjs';
import { NEURON_USD } from './models.mjs';
import { round } from './util.mjs';

export const readLedger = () => {
  if (!fs.existsSync(ledgerFile())) return [];
  return fs
    .readFileSync(ledgerFile(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

export const appendLedger = (entry) => {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
};

export const summarize = (entries, now = new Date()) => {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const month = iso.slice(0, 7);
  const summary = { day, month, todayNeurons: 0, todayUsd: 0, todayCount: 0, monthUsd: 0, monthCount: 0 };
  for (const entry of entries) {
    if (typeof entry.ts !== 'string') continue;
    if (entry.ts.startsWith(day)) {
      summary.todayNeurons += entry.neurons || 0;
      summary.todayUsd += entry.est_usd || 0;
      summary.todayCount += 1;
    }
    if (entry.ts.startsWith(month)) {
      summary.monthUsd += entry.est_usd || 0;
      summary.monthCount += 1;
    }
  }
  summary.todayNeurons = round(summary.todayNeurons, 2);
  summary.todayUsd = round(summary.todayUsd);
  summary.monthUsd = round(summary.monthUsd);
  return summary;
};

export const planCost = (estimate, cfg, summary) => {
  const freeLeft = Math.max(0, cfg.dailyFreeNeurons - summary.todayNeurons);
  const neurons = estimate.neurons || 0;
  const paidNeurons = Math.max(0, neurons - freeLeft);
  return {
    neurons,
    freeLeft: round(freeLeft, 2),
    paidNeurons: round(paidNeurons, 2),
    usd: round((estimate.usd || 0) + paidNeurons * NEURON_USD),
    approx: Boolean(estimate.approx),
  };
};

export const describePlan = (plan) => {
  if (plan.neurons > 0) {
    const tail =
      plan.paidNeurons > 0
        ? `, ${plan.paidNeurons} neurons over the free allowance ≈ $${plan.usd.toFixed(4)}`
        : ', within the free allowance';
    return `estimate: ${plan.neurons} neurons (free allowance left today: ${plan.freeLeft})${tail}`;
  }
  const digits = plan.usd < 0.1 ? 3 : 2;
  return `estimate: ≈ $${plan.usd.toFixed(digits)}${plan.approx ? ' (upper bound above 1 MP)' : ''}`;
};

export const assertGuards = ({ usd, isVideo, yes, overrideBudget }, cfg, summary) => {
  if (!overrideBudget && summary.monthUsd + usd > cfg.monthlyBudgetUsd) {
    throw new GuardError(
      `monthly budget exceeded: already ≈ $${summary.monthUsd.toFixed(2)} + this request ≈ $${usd.toFixed(2)} > $${cfg.monthlyBudgetUsd}. ` +
        'Raise the limit with config set monthlyBudgetUsd <number>, or once with --override-budget',
      4,
    );
  }
  if (!yes && (isVideo || usd > cfg.confirmAboveUsd)) {
    const why = isVideo ? 'video always requires confirmation' : `confirmation threshold $${cfg.confirmAboveUsd}`;
    throw new GuardError(
      `confirmation needed: request ≈ $${usd.toFixed(2)} (${why}). Tell the user the amount and rerun with --yes only after they agree`,
      3,
    );
  }
};
