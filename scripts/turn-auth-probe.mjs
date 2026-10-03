#!/usr/bin/env node
/**
 * TURN authentication probe (security-review INFRA-001).
 *
 * Sends ONE unauthenticated TURN Allocate request (RFC 5766) over UDP and
 * reports what the server answered:
 *
 *   401 Unauthorized  -> exit 0  (auth is enforced — the expected answer)
 *   Allocate success  -> exit 2  (OPEN RELAY: anyone can relay through it)
 *   anything else     -> exit 1  (no answer, other error, malformed)
 *
 * coturn falls back to anonymous access when it cannot read its config,
 * and nothing else notices: voice keeps working and a TCP healthcheck
 * passes. CI boots the pinned image the way the installer does and runs
 * this; operators can run it against their own server too:
 *
 *   node scripts/turn-auth-probe.mjs turn.example.com 3478
 *
 * No dependencies — a STUN message is a 20-byte header plus TLV
 * attributes.
 */
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC_COOKIE = 0x2112a442;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const ATTR_ERROR_CODE = 0x0009;
const UDP_PROTOCOL = 17;

export function buildAllocateRequest(transactionId) {
  const attr = Buffer.alloc(8);
  attr.writeUInt16BE(ATTR_REQUESTED_TRANSPORT, 0);
  attr.writeUInt16BE(4, 2);
  attr.writeUInt8(UDP_PROTOCOL, 4);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(ALLOCATE_REQUEST, 0);
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, attr]);
}

/** Classify a response to our request: 'unauthorized' | 'open' | 'error:<code>' | null (not ours). */
export function classifyResponse(msg, transactionId) {
  if (msg.length < 20) return null;
  if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  if (!msg.subarray(8, 20).equals(transactionId)) return null;
  const type = msg.readUInt16BE(0);
  if (type === ALLOCATE_SUCCESS) return 'open';
  if (type !== ALLOCATE_ERROR) return `unexpected-type:0x${type.toString(16)}`;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let offset = 20;
  while (offset + 4 <= end) {
    const attrType = msg.readUInt16BE(offset);
    const attrLength = msg.readUInt16BE(offset + 2);
    if (attrType === ATTR_ERROR_CODE && attrLength >= 4 && offset + 8 <= end) {
      const code = (msg.readUInt8(offset + 6) & 0x07) * 100 + msg.readUInt8(offset + 7);
      return code === 401 ? 'unauthorized' : `error:${code}`;
    }
    offset += 4 + Math.ceil(attrLength / 4) * 4;
  }
  return 'error:unknown';
}

export async function probeTurn(host, port, { attempts = 3, timeoutMs = 2000 } = {}) {
  const address = isIP(host) ? host : (await lookup(host)).address;
  const socket = dgram.createSocket(isIP(address) === 6 ? 'udp6' : 'udp4');
  const transactionId = randomBytes(12);
  const request = buildAllocateRequest(transactionId);
  try {
    return await new Promise((resolve) => {
      let sent = 0;
      let timer;
      const send = () => {
        if (sent >= attempts) return resolve('no-response');
        sent += 1;
        socket.send(request, port, address);
        timer = setTimeout(send, timeoutMs);
      };
      socket.on('message', (msg) => {
        const verdict = classifyResponse(msg, transactionId);
        if (verdict === null) return;
        clearTimeout(timer);
        resolve(verdict);
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        resolve(`socket-error:${err.message}`);
      });
      send();
    });
  } finally {
    socket.close();
  }
}

const isMain = Boolean(process.argv[1]) && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [host = '127.0.0.1', portArg = '3478'] = process.argv.slice(2);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`turn-auth-probe: invalid port ${portArg}`);
    process.exit(1);
  }
  const verdict = await probeTurn(host, port);
  if (verdict === 'unauthorized') {
    console.log(`turn-auth-probe: ${host}:${port} answered 401 — authentication is enforced`);
    process.exit(0);
  }
  if (verdict === 'open') {
    console.error(`turn-auth-probe: ${host}:${port} ACCEPTED an unauthenticated allocation — this is an OPEN RELAY`);
    process.exit(2);
  }
  console.error(`turn-auth-probe: ${host}:${port} — ${verdict}`);
  process.exit(1);
}
