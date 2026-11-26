import type { CatalogEntry } from './catalog';
export const CACHE_KEY: string;
export function readCatalog(storage: Storage): CatalogEntry[];
export function writeCatalog(storage: Storage, entries: CatalogEntry[]): void;
export function replaceRepository(entries: CatalogEntry[], repo: string, incoming: CatalogEntry[]): CatalogEntry[];
export function dependencyIds(text: string): string[];
