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

export function createServerEntry(
  name: string,
  url: string,
  region = 'eu'
): ServerEntry {
  return {
    id: crypto.randomUUID(),
    name,
    url,
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
