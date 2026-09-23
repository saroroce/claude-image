import http from 'node:http';

const GOOD = 'Bearer good-token';

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

export const startMock = async ({ jpeg, mp4 }) => {
  const state = { requests: [], mode: 'ok', base: '' };

  const handle = (req, res, body) => {
    const { url } = req;
    if (url === '/files/img.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(jpeg);
      return;
    }
    if (url === '/files/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(mp4);
      return;
    }
    if (url === '/client/v4/user/tokens/verify') {
      if (req.headers.authorization === GOOD) send(res, 200, { success: true, result: { status: 'active' } });
      else send(res, 401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] });
      return;
    }
    if (url.endsWith('/tokens/verify')) {
      send(res, 401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] });
      return;
    }
    if (state.mode === 'unauthorized') {
      send(res, 401, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      return;
    }
    if (state.mode === 'quota') {
      send(res, 429, { success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] });
      return;
    }
    const native = /^\/client\/v4\/accounts\/([^/]+)\/ai\/run\/(@cf\/.+)$/.exec(url);
    if (native) {
      send(res, 200, { result: { image: jpeg.toString('base64') }, success: true, errors: [], messages: [] });
      return;
    }
    if (/^\/client\/v4\/accounts\/[^/]+\/ai\/run$/.test(url)) {
      const payload = JSON.parse(body.toString('utf8'));
      if (state.mode === 'failed') {
        send(res, 200, { state: 'Failed', error: { message: 'moderation' }, result: {} });
        return;
      }
      if (payload.model.endsWith('flux-3-video')) {
        const result = { video: `${state.base}/files/clip.mp4` };
        if (payload.input.draft) result.draft_cache = `${state.base}/files/draft-cache.bin`;
        send(res, 200, { state: 'Completed', result, gatewayMetadata: { keySource: 'Unified' } });
        return;
      }
      send(res, 200, { state: 'Completed', result: { image: `${state.base}/files/img.jpg` }, gatewayMetadata: { keySource: 'Unified' } });
      return;
    }
    send(res, 404, { success: false, errors: [{ code: 7000, message: 'No route' }] });
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handle(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;

  return {
    get base() {
      return state.base;
    },
    get requests() {
      return state.requests;
    },
    apiRequests() {
      return state.requests.filter((r) => r.url.includes('/ai/run'));
    },
    reset() {
      state.requests.length = 0;
      state.mode = 'ok';
    },
    setMode(mode) {
      state.mode = mode;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
