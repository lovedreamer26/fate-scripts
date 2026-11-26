// Read-only inventory. Never executes or modifies Foundry documents.
export function readInventory(game, origin) {
  if (!game.ready || !game.user?.isGM) throw new Error('Требуется активная сессия GM.');
  if (!game.world?.id || !game.user.id) throw new Error('Мир или пользователь не определён.');
  return {
    protocol: 2,
    capturedAt: new Date().toISOString(),
    serverOrigin: new URL(origin).origin,
    worldId: game.world.id,
    worldTitle: game.world.title ?? '',
    userId: game.user.id,
    version: game.version,
    system: { id: game.system.id, version: game.system.version },
    macros: Array.from(game.macros.values(), m => ({
      id: m.id, name: m.name, type: m.type, folderId: m.folder?.id ?? null,
      img: m.img ?? '', command: m.command ?? ''
    })),
    folders: Array.from(game.folders.values()).filter(f => f.type === 'Macro').map(f => ({
      id: f.id, name: f.name, parentId: f.folder?.id ?? null
    })),
    modules: Array.from(game.modules.values(), m => ({id:m.id, version:m.version, active:!!m.active}))
  };
}
