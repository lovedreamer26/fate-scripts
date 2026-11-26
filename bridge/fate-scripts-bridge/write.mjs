// Explicit GM-side write; no evaluation of macro code.
export function validateWrite(p, game, origin) {
  if (!game.ready || !game.user?.isGM) throw Error('Требуется GM');
  if (!p || p.protocol !== 3 || p.origin !== origin || p.worldId !== game.world.id) throw Error('Неверный сервер или мир');
  if (!['create','update'].includes(p.action) || typeof p.name !== 'string' || !p.name.trim() || typeof p.code !== 'string' || p.code.length > 2000000) throw Error('Некорректный пакет');
  if (p.action === 'create') return null;
  const m = game.macros.get(p.macroId);
  if (!m || m.type !== 'script' || typeof p.expected !== 'string' || m.command !== p.expected) throw Error('Конфликт версии или отсутствующий макрос');
  return m;
}
export async function applyWrite(p, game, origin, create, approve) {
  const before = validateWrite(p, game, origin);
  if (!await approve({before:before?.command ?? '', after:p.code, name:p.name, action:p.action})) return {status:'cancelled'};
  const current = validateWrite(p, game, origin);
  if (current !== before) throw Error('Макрос изменился');
  const result = current ? await current.update({command:p.code}) : await create({name:p.name,type:'script',command:p.code});
  if (!result?.id || result.command !== p.code) throw Error('Запись не подтверждена; проверьте Foundry вручную');
  return {status:'written',id:result.id};
}
