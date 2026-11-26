export const deckKey = 'fate-scripts.deck.v1';
export const defaultDeck = () => ({tabs:[{id:'main',name:'Основная',buttons:[]}],size:110});
export function readDeck(storage) {
 const raw=storage.getItem(deckKey); if(!raw)return defaultDeck();
 const d=JSON.parse(raw); if(!Array.isArray(d.tabs)||!d.tabs.length||!Number.isFinite(d.size)||d.size<80||d.size>200)throw Error('Некорректная конфигурация панели');
 const ids=new Set(); for(const t of d.tabs){if(typeof t.id!=='string'||ids.has(t.id)||typeof t.name!=='string'||!Array.isArray(t.buttons))throw Error('Некорректная вкладка');ids.add(t.id);for(const b of t.buttons){if(typeof b.id!=='string'||ids.has(b.id)||typeof b.scriptId!=='string'||typeof b.name!=='string'||typeof b.image!=='string'||(b.image&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.image)))throw Error('Некорректная кнопка');ids.add(b.id);}}return d;
}
export function moveButton(buttons,from,to){const a=buttons.findIndex(b=>b.id===from),b=buttons.findIndex(b=>b.id===to);if(a<0||b<0||a===b)return buttons;const next=[...buttons];next.splice(b,0,next.splice(a,1)[0]);return next;}
export function worldMatches(scriptWorld,origin,worldId){return Boolean(worldId)&&(!scriptWorld||scriptWorld===`${origin}#${worldId}`);}
