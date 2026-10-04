// ALTCHA proof-of-work worker for SHA-256/384/512 (Web Crypto, no WASM).
// Bundled by Next as a same-origin worker — see altcha-runtime.ts. The
// imported script installs `self.onmessage` itself.
import 'altcha/workers/sha';
