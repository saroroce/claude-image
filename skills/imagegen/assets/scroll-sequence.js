const pad = (value, width) => String(value).padStart(width, '0');

const frameUrl = (set, index) =>
  set.base + set.pattern.replace(/%0(\d+)d/, (_, width) => pad(set.start + index, Number(width)));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export async function createScrollSequence({
  container,
  canvas,
  manifestUrl,
  mobileQuery = '(max-width: 768px)',
  concurrency = 6,
  coarseStride = 8,
  onProgress,
}) {
  const manifestHref = new URL(manifestUrl, document.baseURI).href;
  const response = await fetch(manifestHref);
  if (!response.ok) throw new Error(`manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  const root = new URL('.', manifestHref).href;
  const useMobile = Boolean(manifest.mobile) && window.matchMedia(mobileQuery).matches;
  const set = useMobile
    ? { ...manifest.mobile, base: `${root}${manifest.mobile.dir}/` }
    : { ...manifest, base: root };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d');

  const state = new Array(set.count).fill('idle');
  const images = new Array(set.count).fill(null);
  const queue = [];
  let active = 0;
  let loaded = 0;
  let current = -1;
  let target = 0;
  let raf = 0;
  let destroyed = false;

  const load = (index) =>
    new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        images[index] = img;
        state[index] = 'ready';
        loaded += 1;
        resolve();
      };
      img.onerror = () => {
        state[index] = 'error';
        resolve();
      };
      img.src = frameUrl(set, index);
    });

  const nearestReady = (index) => {
    for (let distance = 0; distance < set.count; distance += 1) {
      const before = index - distance;
      const after = index + distance;
      if (before >= 0 && state[before] === 'ready') return before;
      if (after < set.count && state[after] === 'ready') return after;
    }
    return -1;
  };

  const draw = (index) => {
    const img = images[index];
    const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const width = img.naturalWidth * scale;
    const height = img.naturalHeight * scale;
    ctx.drawImage(img, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  };

  const render = () => {
    raf = 0;
    if (destroyed) return;
    const index = nearestReady(target);
    if (index < 0 || index === current) return;
    current = index;
    draw(index);
  };

  const schedule = () => {
    if (!raf && !destroyed) raf = requestAnimationFrame(render);
  };

  const pump = () => {
    while (!destroyed && active < concurrency && queue.length) {
      const index = queue.shift();
      if (state[index] !== 'queued') continue;
      state[index] = 'loading';
      active += 1;
      load(index).then(() => {
        active -= 1;
        schedule();
        pump();
      });
    }
  };

  const enqueue = (index, front = false) => {
    if (state[index] === 'queued' && front) {
      queue.splice(queue.indexOf(index), 1);
    } else if (state[index] !== 'idle') {
      return;
    }
    state[index] = 'queued';
    if (front) queue.unshift(index);
    else queue.push(index);
  };

  const progress = () => {
    const rect = container.getBoundingClientRect();
    const span = rect.height - window.innerHeight;
    return span > 0 ? clamp(-rect.top / span, 0, 1) : 0;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    current = -1;
    schedule();
  };

  const onScroll = () => {
    const value = progress();
    target = Math.round(value * (set.count - 1));
    if (state[target] === 'idle' || state[target] === 'queued') {
      enqueue(target, true);
      pump();
    }
    if (onProgress) onProgress(value, target);
    schedule();
  };

  const onResize = () => {
    resize();
    onScroll();
  };

  const destroy = () => {
    destroyed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    images.fill(null);
  };

  resize();
  enqueue(0, true);

  if (reduced) {
    await load(0);
    current = -1;
    target = 0;
    render();
    return { destroy, count: set.count, reduced: true, frame: 0, progress: 0, loaded: 1 };
  }

  for (let index = 0; index < set.count; index += coarseStride) enqueue(index);
  for (let index = 0; index < set.count; index += 1) enqueue(index);
  pump();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  onScroll();

  return {
    destroy,
    count: set.count,
    reduced: false,
    set: useMobile ? 'mobile' : 'desktop',
    get frame() {
      return current;
    },
    get target() {
      return target;
    },
    get progress() {
      return progress();
    },
    get loaded() {
      return loaded;
    },
  };
}
