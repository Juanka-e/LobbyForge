// The author's own site as a plugin's UI (`ui: { url }`): a real origin of
// its own, framed by the lobby with
// sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock".
// It tries what that sandbox must still stop, then reports over frame
// protocol v1 — with the vendored client, which learns the parent's origin
// from the first init.
import { connect } from '/lobbyforge-frame.js';

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

const results = {
  origin: self.origin,
  parentDocument: attempt(() => parent.document.title),
  parentLocation: attempt(() => parent.location.href),
  topNavigation: attempt(() => {
    top.location.href = 'http://127.0.0.1:19600/impostor?top=1';
    return 'tried';
  }),
  popup: attempt(() => window.open('http://127.0.0.1:19600/impostor?popup=1')),
  modal: attempt(() => alert('hello from the site')),
  // Its own origin: storage of its own (partitioned under the lobby).
  ownStorage: attempt(() => {
    localStorage.setItem('k', 'v');
    return localStorage.getItem('k');
  }),
  // The app's API: another origin that sends no CORS headers, reached without the session.
  appApi: await settle(fetch('http://localhost:19598/api/plugin-ui/probe?from=site', { credentials: 'include' }).then((r) => r.text())),
};

const lf = connect({
  onInit(init) {
    results.init = { viewer: init.viewer, players: init.players.length, locale: init.locale, scheme: init.theme.scheme };
    results.parentOrigin = lf.parentOrigin;
  },
  onState(state, revision) {
    results.lastState = { state, revision };
    document.getElementById('out').textContent = JSON.stringify(results);
    if (revision >= 2) lf.dispatch({ type: 'probe-results', results });
  },
});
