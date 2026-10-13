/**
 * Request-body cap for the routes that create or edit a chat message —
 * channel messages (POST and PATCH) and direct messages (security-review
 * AUTHZ-008). A message is at most 4000 characters, which is at most
 * 12 000 bytes of UTF-8 (3 bytes per character outside ASCII), plus the
 * JSON around it. Anything bigger is not a message: 413 before the
 * handler parses it. The default limit of `withApiSecurity` is 1 MiB.
 */
export const MESSAGE_BODY_MAX_BYTES = 16 * 1024;
