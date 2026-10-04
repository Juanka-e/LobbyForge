// ALTCHA proof-of-work worker for PBKDF2/SHA-* (Web Crypto, no WASM).
// Bundled by Next as a same-origin worker — see altcha-runtime.ts. The
// imported script installs `self.onmessage` itself.
import 'altcha/workers/pbkdf2';
