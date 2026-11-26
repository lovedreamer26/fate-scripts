// GM-confirmed execution; temporary macro is never persisted by this adapter.
export function makeRunner({game, origin, temporary, approve}) {
  const seen = new Set();
  let busy = false;
  return async function run(p) {
    if (!game.ready || !game.user?.isGM) throw Error('Требуется GM');
    if (!p || p.protocol !== 4 || p.origin !== origin || p.worldId !== game.world.id || !/^[a-f0-9-]{36}$/i.test(p.runId ?? '')) throw Error('Некорректный запрос или мир');
    if (!['existing','test'].includes(p.action) || (p.action === 'test' && (typeof p.code !== 'string' || p.code.length > 2000000))) throw Error('Некорректный режим');
    if (busy || seen.has(p.runId) || seen.size >= 10000) throw Error('Запуск занят, повторён или исчерпан лимит сессии');
    const macro = p.action === 'existing' ? game.macros.get(p.macroId) : null;
    if (p.action === 'existing' && (!macro || macro.type !== 'script' || macro.command !== p.expected)) throw Error('Макрос отсутствует или изменился');
    busy = true; seen.add(p.runId);
    const base = {runId:p.runId, worldId:p.worldId, startedAt:new Date().toISOString()};
    const logs = [];
    let started;
    let collecting = true;
    const scopedConsole = Object.freeze(Object.fromEntries(['log','warn','error'].map(level=>[level,(...args)=>{
      if (collecting && logs.length < 40) {
        const message = args.slice(0,8).map(value => value !== null && ['object','function'].includes(typeof value)
          ? '[объект]' : String(value).slice(0,256)).join(' ').slice(0,512);
        logs.push({level,message});
      }
      console[level](...args);
    }])));
    try {
      if (!await approve(p)) return {...base,status:'cancelled'};
      if (!game.ready || !game.user?.isGM || game.world.id !== p.worldId || (macro && (game.macros.get(p.macroId) !== macro || macro.command !== p.expected))) throw Error('Контекст изменился');
      const target = macro ?? temporary({name:'Fate Scripts test',type:'script',command:p.code});
      started = performance.now();
      const value = await target.execute({fateScriptsConsole:scopedConsole});
      const result = typeof value === 'string' ? value.slice(0, 4000)
        : value === null || typeof value === 'boolean' || Number.isFinite(value) ? value : undefined;
      return {...base,status:'returned',durationMs:Math.round(performance.now()-started),result,logs,note:'Вызов execute завершился; внутренние ошибки Foundry могут не пробрасываться.'};
    } catch(e) { return {...base,status:'error',durationMs:started===undefined?undefined:Math.round(performance.now()-started),logs,error:String(e?.message ?? e).slice(0,4000),stack:String(e?.stack ?? '').slice(0,12000)}; }
    finally { collecting=false;busy=false; }
  };
}
