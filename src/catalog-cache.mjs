export const CACHE_KEY = 'fate-scripts.catalog.v1';
export function readCatalog(storage) {
  const raw = storage.getItem(CACHE_KEY);
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(e => e && ['name','description','repo','path','commit','author','license','compatibility'].every(k => typeof e[k] === 'string') && /^[a-f0-9]{40}$/.test(e.commit) && (e.code === undefined || typeof e.code === 'string'))) throw new Error('Повреждён кеш каталога');
  return value;
}
export function writeCatalog(storage, entries) { storage.setItem(CACHE_KEY, JSON.stringify(entries)); }
export function replaceRepository(entries, repo, incoming) {
  return [...entries.filter(e => e.repo.toLowerCase() !== repo.toLowerCase()), ...incoming.map(e => ({...e, code: entries.find(old => old.repo === e.repo && old.path === e.path && old.commit === e.commit)?.code}))];
}
export function dependencyIds(text) {
  return [...new Set(text.split(/[\s,;]+/).filter(Boolean).map(id => { if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id)) throw new Error('Некорректный ID модуля: '+id); return id; }))].sort();
}
