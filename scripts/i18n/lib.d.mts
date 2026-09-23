// Types for lib.mjs, so TypeScript tests can drive the same tooling the
// `pnpm i18n:*` commands use.

export const SOURCE: 'en';
export const META_FILE: '_locale.json';
export const CODE_PATTERN: RegExp;
export const PLUGIN_INDEX: string;
export const REPO_ROOT: string;

export interface AppRow {
  code: string;
  name: string;
  englishName: string;
  status: string;
  dir: string;
  total: number;
  translated: number;
}

export interface PluginRow {
  id: string;
  languages: Array<{ code: string; total: number; translated: number; partial?: boolean }>;
}

export interface StatusReport {
  problems: string[];
  appRows: AppRow[];
  pluginRows: PluginRow[];
  englishOnlyPlugins: string[];
}

export function paths(root?: string): { appMessages: string; plugins: string };
export function placeholders(text: string): string;
export function messageArguments(text: string): string[];
export function messageProblems(text: string): string[];
export function status(root?: string): StatusReport;
export function sync(options?: { root?: string; prune?: boolean }): string[];
export function addLanguage(options: {
  root?: string;
  code: string;
  name?: string;
  englishName?: string;
  rtl?: boolean;
}): string[];
export function markComplete(options: { root?: string; code: string }): void;
export function pluginIndexSource(codes: string[]): string;

export type Table = Record<string, string>;
export function readAppLocales(root?: string): {
  locales: Array<{ code: string; meta: Record<string, unknown>; files: Record<string, Table> }>;
  problems: string[];
};
export function readPlugins(root?: string): {
  withTables: Array<{ id: string; dir: string; localesDir: string; tables: Record<string, Table> }>;
  englishOnly: string[];
};
