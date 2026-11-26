type Entry = {folder: string; world: string};
export function folderPath(value: string): string;
export function folderTree(entries: Entry[], world: string): string[];
export function inFolder(entry: Entry, folder: string | null): boolean;
export function redactSecrets(text: string): string;
export function sameJsonValue(a: unknown, b: unknown): boolean;
