// A hostile-ish plugin UI: it tries everything the sandbox must stop, then
// reports what happened through the frame protocol (the only way out).
import { connect } from './lobbyforge-frame.js';

const violations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
});

const attempt = (fn) => {
  try {
    return `allowed:${String(fn())}`;
  } catch (e) {
    return `blocked:${e.name}`;
  }
};
const settle = (promise) =>
  promise.then(
    () => 'allowed',
    () => 'blocked'
  );
const audio = (src) =>
  new Promise((resolve) => {
    const a = new Audio();
    a.onloadedmetadata = () => resolve('loaded');
    a.onerror = () => resolve('blocked');
    a.src = src;
  });
// The smallest valid module: compiling it needs 'wasm-unsafe-eval'.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const image = (src) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve('loaded');
    img.onerror = () => resolve('blocked');
    img.src = src;
  });

const results = {
  origin: self.origin,
  inlineScriptRan: window.__inline === true,
  cookie: attempt(() => document.cookie),
  parentDocument: attempt(() => parent.document.title),
  parentCookie: attempt(() => parent.document.cookie),
  localStorage: attempt(() => {
    localStorage.setItem('k', 'v');
    return localStorage.getItem('k');
  }),
  popup: attempt(() => window.open('https://example.com/')),
  appFetch: await settle(fetch('/lobby')),
  apiFetch: await settle(fetch('/api/health')),
  otherPluginFetch: await settle(fetch('/api/plugin-ui/sandbox-buzzer/' + new URL(location.href).searchParams.get('other') + '/style.css')),
  ownFileFetch: await settle(fetch('dot.svg')),
  ownWasm: await settle(WebAssembly.instantiate(EMPTY_WASM)),
  ownAudio: await audio('beep.wav'),
  externalAudio: await audio('https://example.com/beep.wav'),
  externalFetch: await settle(fetch('https://example.com/')),
  externalImage: await image('https://example.com/pixel.png'),
  ownImage: await image('dot.svg'),
};

const lf = connect({
  onInit(init) {
    const root = document.documentElement;
    results.init = {
      viewer: init.viewer,
      players: init.players.length,
      locale: init.locale,
      scheme: init.theme.scheme,
      appliedSurface: getComputedStyle(root).getPropertyValue('--lf-surface').trim(),
      dataTheme: root.getAttribute('data-lf-theme'),
      lang: root.getAttribute('lang'),
    };
  },
  onState(state, revision) {
    results.lastState = { state, revision };
    document.getElementById('out').textContent = JSON.stringify(results);
    lf.dispatch({ type: 'probe-results', results: { ...results, violations } });
  },
});
