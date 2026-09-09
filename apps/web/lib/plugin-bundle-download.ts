/**
 * Review-time bundle fetch — re-exports the installer's hardened
 * downloader (HTTPS-only, SSRF-checked, IP-pinned) so the digest the
 * reviewer pins and the bytes the installer later verifies share ONE
 * download path.
 */
export { downloadBundleForReview } from './plugin-installer';
