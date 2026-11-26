export function repositoryName(value) {
  const name = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(name) || /\/(?:\.|\.\.)$/.test(name)) throw new Error('Укажите публичный репозиторий GitHub.');
  return name.toLowerCase();
}
export function filterCatalog(entries, query, repo, license) {
  const q = query.trim().toLocaleLowerCase('ru');
  return entries.filter(e => (!repo || e.repo.toLowerCase() === repo.toLowerCase()) && (!license || e.license === license) && [e.name,e.description,e.path,e.repo,e.author].some(v => v.toLocaleLowerCase('ru').includes(q)));
}
export function dependencyStatus(ids, snapshot, origin, worldId) {
  const usable = snapshot && snapshot.serverOrigin === origin && snapshot.worldId === worldId && Array.isArray(snapshot.modules);
  return [...new Set(ids)].sort().map(id => {
    const module = usable ? snapshot.modules.find(m => m.id === id) : undefined;
    return {id, version: module?.version ?? '', status: !usable ? 'unknown' : !module ? 'missing' : module.active ? 'active' : 'inactive'};
  });
}
