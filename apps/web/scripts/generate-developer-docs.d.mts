export interface DeveloperDocSource {
  slug: string;
  path: string;
}

export const DEVELOPER_DOC_SOURCES: readonly DeveloperDocSource[];
export const GENERATED_MODULE_PATH: string;
export const REPO_ROOT: string;

export function normalizeMarkdown(text: string): string;
export function buildDeveloperDocsModule(root?: string): string;
export function writeDeveloperDocsModule(root?: string): { path: string; changed: boolean };
export function isDeveloperDocsModuleCurrent(root?: string): boolean;
