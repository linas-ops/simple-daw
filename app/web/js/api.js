// Calls to the local Simple DAW server (server.py).

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body, { raw = false, timeoutMs = 0 } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    opts.body = body;
    opts.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let controller = null;
  let timer = null;
  if (timeoutMs) {
    controller = new AbortController();
    opts.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new ApiError(err.name === 'AbortError' ? 'The request took too long.' : 'Simple DAW’s engine isn’t running. Start it again with “Start Simple DAW”.', 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || (data && data.ok === false)) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}

const get = (url, o) => request('GET', url, undefined, o);
const post = (url, body, o) => request('POST', url, body ?? {}, o);

export const api = {
  hello: () => get('/api/hello', { timeoutMs: 4000 }),
  heartbeat: () => get('/api/heartbeat', { timeoutMs: 4000 }).catch(() => null),
  bye: () => { try { navigator.sendBeacon('/api/bye', new Blob(['{}'], { type: 'application/json' })); } catch { /* ignore */ } },
  quit: () => post('/api/quit'),
  saveSettings: (values) => post('/api/settings', values).catch(() => null),

  plugins: () => get('/api/plugins'),
  browsePlugin: () => post('/api/plugins/browse'),
  addPluginFolder: () => post('/api/plugins/add-folder'),

  loadPlugin: (path, sampleRate, state) => post('/api/engine/load', { path, sampleRate, state }),
  loadKit: (path, sampleRate, options) => post('/api/engine/load-kit', { path, sampleRate, options }),
  // Open another kit so a single drum can borrow one of its sounds.
  describeKit: (path, sampleRate, options, preload) => post('/api/engine/describe-kit', { path, sampleRate, options, preload }),
  // How many recordings (variations) a drum's sound has.
  takes: (path, options, note, raw) => post('/api/engine/takes', { path, options, note, raw }),
  kits: () => get('/api/kits'),
  kitsStatus: () => get('/api/kits/status'),
  installKit: (id) => post('/api/kits/install', { id }),
  addKitFolder: () => post('/api/kits/add-folder'),
  openEditor: () => post('/api/engine/editor'),
  setPluginState: (state) => post('/api/engine/state', { state }),
  unloadPlugin: () => post('/api/engine/unload').catch(() => null),

  async render(payload) {
    const res = await request('POST', '/api/engine/render', payload, { raw: true });
    const frames = Number(res.headers.get('X-Frames'));
    const channels = Number(res.headers.get('X-Channels')) || 2;
    const sampleRate = Number(res.headers.get('X-Sample-Rate'));
    const ms = Number(res.headers.get('X-Render-Ms')) || 0;
    const buf = await res.arrayBuffer();
    const all = new Float32Array(buf);
    const data = [];
    for (let c = 0; c < channels; c++) data.push(all.subarray(c * frames, (c + 1) * frames));
    return { frames, channels, sampleRate, data, ms };
  },

  projects: () => get('/api/projects'),
  loadProject: (file) => get(`/api/projects/load?file=${encodeURIComponent(file)}`),
  saveProject: (file, project) => post('/api/projects/save', { file, project }),
  deleteProject: (file) => post('/api/projects/delete', { file }),

  uploadMedia: (name, blob) => request('POST', `/api/media?name=${encodeURIComponent(name)}`, blob),
  mediaUrl: (id) => `/media/${encodeURIComponent(id)}`,

  saveExport: (name, ext, blob) => request('POST', `/api/export?name=${encodeURIComponent(name)}&ext=${ext}`, blob),
  reveal: (path) => post('/api/reveal', { path }).catch(() => null),
  openFolder: (which) => post('/api/open-folder', { which }).catch(() => null),
};
