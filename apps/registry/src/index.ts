export const APP_NAME = 'LobbyForge Registry';

export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  description?: string;
  region: string;
  tags: string[];
  publicListed: boolean;
  createdAt: Date;
}

export interface RegistryUrlValidationOptions {
  allowLoopbackHttp?: boolean;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.localhost') ||
    normalized.startsWith('127.');
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateIpv6 = normalized.includes(':') && (
    normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
  );
  return isLoopback(normalized) || isPrivateIpv4(normalized) ||
    privateIpv6 ||
    normalized.endsWith('.local') || normalized.endsWith('.internal');
}

export function normalizeRegistryInstanceUrl(
  input: string,
  options: RegistryUrlValidationOptions = {}
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Instance URL is invalid');
  }
  const loopbackDevUrl = options.allowLoopbackHttp === true && isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !(loopbackDevUrl && url.protocol === 'http:')) {
    throw new Error('Instance URL must use HTTPS');
  }
  if (url.username || url.password) throw new Error('Instance URL must not contain credentials');
  if (url.hash || url.search) throw new Error('Instance URL must not contain query or fragment data');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Instance URL must be an origin');
  if (isPrivateHost(url.hostname) && !loopbackDevUrl) {
    throw new Error('Private network instance URLs cannot be publicly registered');
  }
  return url.origin;
}

export function createServerEntry(
  name: string,
  url: string,
  region = 'eu'
): ServerEntry {
  return {
    id: crypto.randomUUID(),
    name,
    url: normalizeRegistryInstanceUrl(url),
    region,
    tags: [],
    publicListed: false,
    createdAt: new Date(),
  };
}

export function listPublicEntries(entries: ServerEntry[]): ServerEntry[] {
  return entries.filter((e) => e.publicListed);
}

export function findEntryById(entries: ServerEntry[], id: string): ServerEntry | undefined {
  return entries.find((e) => e.id === id);
}
