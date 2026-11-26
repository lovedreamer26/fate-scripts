// Pure helpers shared by the library UI and regression tests.
export function folderPath(value) {
  const parts = value.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Недопустимый путь папки.');
  return parts.join('/');
}
function readPath(value) { try { return folderPath(value); } catch { return value; } }
export function folderTree(entries, world) {
  const paths = new Set();
  for (const entry of entries.filter(item => item.world === world)) {
    const parts = readPath(entry.folder).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
  }
  return [...paths].sort((a,b) => a.localeCompare(b, 'ru'));
}
export function inFolder(entry, folder) {
  return folder === null || (folder === '' ? !readPath(entry.folder) : readPath(entry.folder) === folder || readPath(entry.folder).startsWith(folder + '/'));
}
export function redactSecrets(text) {
  return text.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~-]{20,})\b/g, '[REDACTED]');
}

export function sameJsonValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => Object.hasOwn(b, key) && sameJsonValue(a[key], b[key]));
}
