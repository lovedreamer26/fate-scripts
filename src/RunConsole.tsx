import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {redactSecrets} from "./library-tools.mjs";
import {stateLabel} from "./LiveBridge";

type Entry = {
  runId:string; name?:string; status:string; origin?:string; worldId?:string; createdAt?:string;
  result?:{ status:string; durationMs?:number; error?:string; stack?:string; result?:unknown };
};

const clearable = new Set(["reported","unknown","expired","cancelled"]);

const label=(status:string)=>stateLabel[status]??({awaitingReport:"Окончательный отчёт отсутствует",written:"Записан",reported:"Отчёт получен"} as Record<string,string>)[status]??status;

export function RunConsole({onPrepare}: {onPrepare?: (context: string) => void} = {}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [opened,setOpened]=useState(false);
  const [entries,setEntries]=useState<Entry[]>([]);
  const [query,setQuery]=useState("");
  const [filter,setFilter]=useState("");
  const [message,setMessage]=useState("");
  const [clearing,setClearing]=useState(false);
  useEffect(()=>{
    if(!opened)return;
    let active=true;
    const refresh=()=>void invoke<Entry[]>("list_run_reports").then(entries=>{
      if(active)setEntries(entries);
    }).catch(error=>{if(active)setMessage(String(error));});
    refresh();
    const timer=window.setInterval(refresh,1500);
    return ()=>{active=false;window.clearInterval(timer);};
  },[opened]);
  const status=(entry:Entry)=>entry.result?.status??entry.status;
  const search=query.trim().toLocaleLowerCase("ru");
  async function clearReports(){
    if (!confirm("Удалить завершённые отчёты? Операции, ожидающие отчёта, останутся в журнале.")) return;
    setClearing(true);
    try {
      const count=await invoke<number>("clear_run_reports");
      setEntries(await invoke<Entry[]>("list_run_reports"));
      setFilter("");
      setMessage(`Удалено отчётов: ${count}`);
    } catch(error) {
      setMessage(String(error));
    } finally {
      setClearing(false);
    }
  }
  const visible=entries.filter(entry=>(!filter||status(entry)===filter)&&JSON.stringify(entry).toLocaleLowerCase("ru").includes(search));
  return <>
    <button onClick={()=>{dialog.current?.showModal();setOpened(true);}}>Журнал Bridge</button>
    <dialog ref={dialog} onClose={()=>setOpened(false)} className="run-console">
      <div className="toolbar"><h2>Журнал Bridge</h2><button onClick={()=>dialog.current?.close()}>Закрыть</button></div>
      <div className="toolbar">
        <input aria-label="Поиск по отчётам" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Поиск по отчётам"/>
        <select value={filter} onChange={event=>setFilter(event.target.value)} aria-label="Статус операции">
          <option value="">Все статусы</option>
          {[...new Set(entries.map(status))].map(id=><option key={id} value={id}>{label(id)}</option>)}
        </select>
        <button disabled={clearing||!entries.some(entry=>clearable.has(entry.status))} onClick={()=>void clearReports()}>Очистить завершённые</button>
      </div>
      <p role="status">{message}</p>
      {visible.length===0&&<p>Записи не найдены.</p>}
      {visible.map(entry=><details key={entry.runId}>
        <summary>{entry.name||entry.runId} · {label(status(entry))}{entry.worldId&&` · ${entry.worldId}`}{entry.result?.durationMs!==undefined&&` · ${entry.result.durationMs} мс`}</summary>
        {entry.createdAt&&<small>{entry.createdAt}</small>}
        <pre>{JSON.stringify(entry,null,2)}</pre>
        <button onClick={()=>void navigator.clipboard.writeText(redactSecrets(JSON.stringify(entry,null,2))).then(()=>setMessage("Отчёт скопирован")).catch(error=>setMessage(String(error)))}>Копировать отчёт</button>
        {onPrepare && <button onClick={() => {
          onPrepare(redactSecrets(JSON.stringify(entry,null,2)));
          dialog.current?.close();
        }}>Добавить к промпту ChatGPT</button>}
      </details>)}
    </dialog>
  </>;
}
