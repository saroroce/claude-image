import { UsageError } from './errors.mjs';
import { MP, round } from './util.mjs';

export const NEURON_USD = 0.011 / 1000;

export const MODELS = {
  'klein-4b': {
    id: '@cf/black-forest-labs/flux-2-klein-4b',
    label: 'FLUX.2 klein 4B',
    transport: 'multipart',
    maxRefs: 4,
    pricing: { kind: 'neurons-tiles', out: 26.05, in: 5.37 },
  },
  'klein-9b': {
    id: '@cf/black-forest-labs/flux-2-klein-9b',
    label: 'FLUX.2 klein 9B',
    transport: 'multipart',
    maxRefs: 4,
    pricing: { kind: 'neurons-mp', first: 1363.64, next: 181.82 },
  },
  schnell: {
    id: '@cf/black-forest-labs/flux-1-schnell',
    label: 'FLUX.1 schnell',
    transport: 'json',
    maxRefs: 0,
    fixedSize: { width: 1024, height: 1024 },
    defaultSteps: 4,
    pricing: { kind: 'neurons-tiles-steps', tile: 4.8, step: 9.6 },
  },
  pro: {
    id: 'black-forest-labs/flux-2-pro-preview',
    label: 'FLUX.2 pro',
    transport: 'unified',
    maxRefs: 8,
    pricing: { kind: 'usd-mp', first: 0.03, edit: 0.045, next: null },
  },
  flex: {
    id: 'black-forest-labs/flux-2-flex',
    label: 'FLUX.2 flex',
    transport: 'unified',
    maxRefs: 8,
    pricing: { kind: 'usd-mp', first: 0.05, edit: 0.05, next: null },
  },
  max: {
    id: 'black-forest-labs/flux-2-max',
    label: 'FLUX.2 max',
    transport: 'unified',
    maxRefs: 8,
    pricing: { kind: 'usd-mp', first: 0.07, edit: 0.07, next: null },
  },
};

export const TIERS = { draft: 'klein-4b', final: 'pro', text: 'flex', hero: 'max' };

export const VIDEO = {
  id: 'black-forest-labs/flux-3-video',
  label: 'FLUX.3 Video',
  perSecond: {
    t2v: { hd: 0.17, fhd: 0.29, draft: 0.06 },
    i2v: { hd: 0.17, fhd: 0.29, draft: 0.06 },
    v2v: { hd: 0.41, fhd: 0.53, draft: 0.12 },
  },
};

export const resolveModelKey = ({ model, tier }) => {
  if (model) {
    if (MODELS[model]) return { key: model, label: model };
    const byId = Object.entries(MODELS).find(([, entry]) => entry.id === model);
    if (byId) return { key: byId[0], label: byId[0] };
    throw new UsageError(`unknown model "${model}". Available: ${Object.keys(MODELS).join(', ')}`);
  }
  const name = tier || 'draft';
  if (!TIERS[name]) {
    throw new UsageError(`unknown tier "${name}". Available: ${Object.keys(TIERS).join(', ')}`);
  }
  return { key: TIERS[name], label: name };
};

export const estimateImage = (key, { width, height, refs = 0, steps = null }, cfg = {}) => {
  const model = MODELS[key];
  const pricing = { ...model.pricing, ...(cfg.prices?.[key] || {}) };
  const mpBilled = Math.max(1, Math.ceil((width * height) / MP));
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  switch (pricing.kind) {
    case 'neurons-tiles':
      return { neurons: round(tiles * pricing.out + refs * pricing.in, 2), usd: 0 };
    case 'neurons-tiles-steps':
      return { neurons: round(tiles * pricing.tile + (steps ?? model.defaultSteps) * pricing.step, 2), usd: 0 };
    case 'neurons-mp':
      return { neurons: round(pricing.first + (mpBilled - 1) * pricing.next, 2), usd: 0 };
    case 'usd-mp': {
      const first = refs > 0 ? pricing.edit ?? pricing.first : pricing.first;
      const next = pricing.next ?? first;
      return { neurons: 0, usd: round(first + (mpBilled - 1) * next), approx: pricing.next == null && mpBilled > 1 };
    }
    default:
      throw new UsageError(`unknown pricing scheme: ${pricing.kind}`);
  }
};

export const estimateVideo = ({ mode, resolution, draft, duration }, cfg = {}) => {
  const table = { ...VIDEO.perSecond[mode], ...(cfg.prices?.video?.[mode] || {}) };
  const rate = draft ? table.draft : table[resolution];
  return { neurons: 0, usd: round(rate * duration), rate };
};
