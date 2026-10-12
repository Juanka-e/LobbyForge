// A plugin's own files (`ui: true`) whose manifest asks for two outside
// origins under `network.connect`, of which the owner approved ONE
// (playwright.config.ts). It reaches each, plus one it never asked for, and
// reports what the frame's policy let through.
import { connect } from './lobbyforge-frame.js';

const violations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
});

const id = new URL(location.href).searchParams.get('id');
const reach = (url) =>
  fetch(url).then(
    (r) => r.json().then((body) => (body.pong ? 'allowed' : 'odd')),
    () => 'blocked'
  );

const results = {
  origin: self.origin,
  approved: await reach(`http://127.0.0.1:19599/ping?id=${id}`),
  askedNotApproved: await reach(`http://127.0.0.1:19600/ping?id=${id}`),
  neverAsked: await reach(`http://127.0.0.1:19601/ping?id=${id}`),
};

const lf = connect({
  onState() {
    lf.dispatch({ type: 'probe-results', results: { ...results, violations } });
  },
});
