import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {stateLabel,useLiveBridge} from './LiveBridge';
import { detectDependencies } from './dependencies';
import { dependencyIds } from './catalog-cache.mjs';
import { dependencyStatus, type ModuleSnapshot } from './catalog-tools.mjs';
import {deckKey,defaultDeck,readDeck,moveButton,type DeckConfig,type DeckButton} from './deck-tools.mjs';
type Entry={id:string;name:string;world:string;code:string;dependencies?:string};
const dependencyWarnings: Record<string,string> = {
  inactive:"модуль отключён", missing:"модуль отсутствует в снимке", unknown:"нет снимка для этого мира",
};
type SavedDeck={revision:number;payload:unknown};
const parseDeck=(payload:unknown)=>readDeck({getItem:()=>JSON.stringify(payload)});
export function Deck({scripts,onSelect}:{scripts:Entry[];onSelect:(id:string)=>void}){
 const [error,setError]=useState('');
 const live=useLiveBridge();
 const starting=useRef(false);
 const [launching,setLaunching]=useState('');
 const operation=live.operation;
 const activeRun=Boolean(operation&&['waiting','claimed'].includes(operation.snapshot.status));
 async function launch(id:string){
   if(live.status!=='connected'){onSelect(id);return;}
   const script = scripts.find(entry => entry.id === id);
   if(starting.current||activeRun||!script||!live.origin||!live.worldId)return;
   if(script.world && script.world !== `${live.origin}#${live.worldId}`) {
     setError("Скрипт принадлежит другому миру");
     return;
   }
   starting.current=true;
   setLaunching(id);setError('');
   try {
     let detected: string[] = [];
     try { detected = detectDependencies(script.code); } catch { /* Foundry reports runtime syntax errors. */ }
     const manual = dependencyIds(script.dependencies ?? "");
     const ids = [...new Set([...detected, ...manual])];
     if (ids.length) {
       const snapshot = await invoke<ModuleSnapshot | null>("bridge_module_inventory");
       const rows = dependencyStatus(ids, snapshot, live.origin, live.worldId);
       const warnings = rows.filter(row => dependencyWarnings[row.status]).map(row =>
         `${row.id} (${manual.includes(row.id) ? "указан вручную" : "обнаружен в коде"}) — ${dependencyWarnings[row.status]}${row.version ? " (" + row.version + ")" : ""}`
       );
       if (rows.some(row => row.status !== "unknown")) {
         const age = Date.now() - Date.parse(snapshot?.capturedAt ?? "");
         if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000) {
           warnings.unshift("Снимок модулей старше 15 минут или его дата неизвестна.");
         }
       }
       if (warnings.length && !confirm(`Проверьте зависимости перед запуском.

${warnings.join("\n")}

Запустить макрос?`)) return;
     }
     await invoke("live_enqueue",{scriptId:id,runId:crypto.randomUUID(),write:null});
   }
   catch(error){setError(String(error));}
   finally{starting.current=false;setLaunching('');}
 }
 const [config,setConfig]=useState<DeckConfig>(defaultDeck);
 const revision=useRef(0);
 const saving=useRef(false);
 const [ready,setReady]=useState(false);
 const [busy,setBusy]=useState(false);
 const [sizeDraft,setSizeDraft]=useState(config.size);
 const [tabId,setTabId]=useState(config.tabs[0].id); const [scriptId,setScriptId]=useState(''); const [editing,setEditing]=useState(false);
 useEffect(()=>{
   let active=true;
   let reading=false;
   async function sync(){
     if(reading||saving.current)return;
     reading=true;
     try {
       let saved=await invoke<SavedDeck|null>('load_deck');
       if(!active)return;
       if(!saved&&localStorage.getItem(deckKey)){
         const legacy=readDeck(localStorage);
         try{saved=await invoke<SavedDeck>('save_deck',{revision:0,payload:legacy});}
         catch(error){
           saved=await invoke<SavedDeck|null>('load_deck');
           if(!saved)throw error;
         }
       }
       if(!active||saving.current)return;
       if(saved&&saved.revision>revision.current){
         const next=parseDeck(saved.payload);
         revision.current=saved.revision;
         setConfig(next);
         setSizeDraft(next.size);
       }
       setReady(true);
     }catch(error){if(active)setError(String(error));}
     finally{reading=false;}
   }
   void sync();
   const timer=window.setInterval(()=>void sync(),1000);
   return ()=>{active=false;window.clearInterval(timer);};
 },[]);
 const tab=config.tabs.find(t=>t.id===tabId)??config.tabs[0];
 const displayedRevision=revision.current;
 async function save(next:DeckConfig){
   if(!ready||saving.current)return;
   if(displayedRevision!==revision.current){
     setError('Панель уже изменилась. Повторите действие с текущими настройками.');
     return;
   }
   saving.current=true;
   setBusy(true);
   try{
     const saved=await invoke<SavedDeck>('save_deck',{revision:displayedRevision,payload:next});
     const savedConfig=parseDeck(saved.payload);
     revision.current=saved.revision;
     setConfig(savedConfig);
     setSizeDraft(savedConfig.size);
     setError('');
   }catch(error){setSizeDraft(config.size);setError(String(error));}
   finally{saving.current=false;setBusy(false);}
 }
 function buttons(next:DeckButton[]){save({...config,tabs:config.tabs.map(t=>t.id===tab.id?{...t,buttons:next}:t)})}
 function patch(id:string,p:Partial<DeckButton>){buttons(tab.buttons.map(b=>b.id===id?{...b,...p}:b))}
 return <section className="deck" aria-busy={busy||!ready}><fieldset disabled={busy||!ready} className="deck-controls"><div className="toolbar"><strong>Панель запуска</strong><span role="status">{stateLabel[live.status]??live.status}{live.worldId&&` · ${live.worldId}`}</span><button onClick={()=>setEditing(!editing)}>{editing?'Готово':'Настроить'}</button><label>Размер <input type="range" min="80" max="200" value={sizeDraft} onChange={e=>setSizeDraft(Number(e.target.value))} onBlur={e=>{const size=Number(e.target.value);if(size!==config.size)void save({...config,size})}} onPointerUp={e=>{const size=Number(e.currentTarget.value);if(size!==config.size)void save({...config,size})}}/></label></div><div className="toolbar">{config.tabs.map(t=><button key={t.id} aria-current={t.id===tab.id} onClick={()=>setTabId(t.id)}>{t.name}</button>)}{editing&&<><button onClick={()=>{const name=prompt('Название вкладки')?.trim();if(name){const id=crypto.randomUUID();save({...config,tabs:[...config.tabs,{id,name,buttons:[]}]});setTabId(id)}}}>+ Вкладка</button><button onClick={()=>{const name=prompt('Название вкладки',tab.name)?.trim();if(name)save({...config,tabs:config.tabs.map(t=>t.id===tab.id?{...t,name}:t)})}}>Переименовать</button><button disabled={config.tabs.length===1} onClick={()=>{if(confirm('Удалить вкладку и её кнопки? Скрипты останутся.'))save({...config,tabs:config.tabs.filter(t=>t.id!==tab.id)})}}>Удалить вкладку</button></>}</div>{editing&&<div className="toolbar"><select value={scriptId} onChange={e=>setScriptId(e.target.value)}><option value="">Выберите сохранённый скрипт</option>{scripts.map(s=><option key={s.id} value={s.id}>{s.name} · {s.world||'Общий'}</option>)}</select><button disabled={!scripts.some(s=>s.id===scriptId)} onClick={()=>{const s=scripts.find(s=>s.id===scriptId);if(s)buttons([...tab.buttons,{id:crypto.randomUUID(),scriptId:s.id,name:s.name,image:''}])}}>Добавить кнопку</button></div>}<p role="status">{error}</p><div className="deck-grid" style={{gridTemplateColumns:`repeat(auto-fill,minmax(${config.size}px,1fr))`}}>{tab.buttons.map(b=>{const s=scripts.find(s=>s.id===b.scriptId);return <div className="deck-tile" key={b.id} draggable={editing} onDragStart={e=>e.dataTransfer.setData('text/plain',b.id)} onDragOver={e=>{if(editing)e.preventDefault()}} onDrop={e=>{if(editing){e.preventDefault();buttons(moveButton(tab.buttons,e.dataTransfer.getData('text/plain'),b.id))}}}><button disabled={!s||editing||!!launching||activeRun} style={{minHeight:config.size}} onClick={()=>void launch(b.scriptId)}>{b.image&&<img src={b.image} alt=""/>}{b.name}<small>{s?s.world||'Общий':'Скрипт удалён'}</small>{launching===b.scriptId?<small>Отправка…</small>:operation?.scriptId===b.scriptId&&<small>{stateLabel[operation.snapshot.result?.status??operation.snapshot.status]??operation.snapshot.status}</small>}</button>{editing&&<><input aria-label="Название кнопки" key={b.name} defaultValue={b.name} onBlur={e=>{if(e.target.value!==b.name)patch(b.id,{name:e.target.value})}}/><input aria-label="Изображение кнопки" type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>256000||!['image/png','image/jpeg','image/webp'].includes(f.type)){setError('Изображение PNG/JPEG/WebP до 256 КБ');return}const r=new FileReader();r.onload=()=>patch(b.id,{image:String(r.result)});r.onerror=()=>setError('Ошибка чтения изображения');r.readAsDataURL(f)}}/><button onClick={()=>patch(b.id,{image:''})}>Убрать изображение</button><button onClick={()=>buttons(tab.buttons.filter(x=>x.id!==b.id))}>Удалить кнопку</button></>}</div>})}</div></fieldset></section>
}
