# Scroll-driven video

A plain mp4 scrubbed with `video.currentTime` stutters, mostly in mobile Safari. The robust pattern is an image sequence painted on a canvas by scroll progress.

## Pipeline

1. Generate the clip (`video`). Audio off.
2. `imagegen frames clip.mp4 --out public/media/hero --mobile 640` writes `manifest.json`, `frame_0001...` and a lighter `mobile/` set.
3. Load `assets/scroll-sequence.js` on the page.

## Markup

```html
<section id="sequence" style="position:relative;height:400vh">
  <canvas id="canvas" style="position:sticky;top:0;width:100%;height:100vh;display:block"></canvas>
</section>
<script type="module">
  import { createScrollSequence } from '/scroll-sequence.js';
  const seq = await createScrollSequence({
    container: document.getElementById('sequence'),
    canvas: document.getElementById('canvas'),
    manifestUrl: '/media/hero/manifest.json',
    onProgress: (progress, frame) => {},
  });
</script>
```

The container height sets the scroll length (400vh means four screens for the whole clip). Text blocks can be positioned over the sticky canvas and driven from `onProgress`.

React or Next.js: call `createScrollSequence` inside `useEffect` of a client component, keep the returned `destroy` and call it in the cleanup.

## Budgets

- Frames: about 12 fps and at most 240 frames on desktop (1280 px wide), at most 120 frames at 640 px on phones. `frames` enforces this with `--fps`, `--max-frames`, `--width`, `--mobile`.
- Weight: keep the desktop set under about 25 MB (the CLI warns). WebP is roughly half of JPEG; install an ffmpeg build with libwebp (`brew install ffmpeg` on most setups, `apt install ffmpeg` on Ubuntu) to get it.
- Memory: decoded frames are large (1280x720 is about 3.7 MB each), so the module keeps only `Image` objects and lets the browser evict decoded data. Do not switch to `createImageBitmap` for every frame.
- First paint: the first frame is fetched before anything else; give the canvas a matching `background` or a poster `<img>` so the section is not empty while loading.
- `prefers-reduced-motion`: the module paints only the first frame and attaches no scroll listener.
- Hosting: serve frames with long cache headers (Cloudflare Pages, R2 or any CDN).

## Pitfalls

- Generated video often garbles text and UI on device screens. Keep the screen dark or abstract in the clip and show real UI as HTML between scenes.
- One take is rarely enough: iterate on `--draft` clips, pay for the 20 s final once.
- A clip is 16:9 or 9:16, not both. For a portrait phone layout generate a separate 9:16 clip or crop while cutting frames.
- Check LCP and CLS on the finished page (Cloudflare plugin skill `web-perf`).
