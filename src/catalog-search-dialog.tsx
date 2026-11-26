import { Backpack, BookOpen, HeartPulse, Map, Scan, ScrollText, Search, Shield, Sparkles, Swords, Users, WandSparkles, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { composeQueries, initialQueue, presets, queueFinished, readQueue, runDiscovery, saveQueue, type DiscoveryQueue } from "./catalog-discovery";

const selectionKey = "catalog.discovery.selection.v1";
const icons: Record<string,LucideIcon> = {Backpack,BookOpen,HeartPulse,Map,Scan,ScrollText,Shield,Sparkles,Swords,Users,WandSparkles,Zap};

function lastSelection(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(selectionKey) ?? "null");
    if (Array.isArray(saved)) return presets.filter(preset=>saved.includes(preset.id)).map(preset=>preset.id);
  } catch { /* Use the default selection. */ }
  return ["all"];
}

export function CatalogSearchDialog({index, disabled}: {
  index: (repo: string, signal: AbortSignal) => Promise<number>;
  disabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [selected,setSelected] = useState(lastSelection);
  const [custom,setCustom] = useState("");
  const [queue,setQueue] = useState(readQueue);
  const [running,setRunning] = useState(false);
  const [activity,setActivity] = useState("");
  const [notice,setNotice] = useState("");
  const [now,setNow] = useState(Date.now);
  const queries = composeQueries(selected,custom);
  const unfinished = queue && !queueFinished(queue);
  const retryAt = queue?.retryAt ?? 0;
  const waiting = retryAt > now;

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(()=>setNow(Date.now()),Math.min(retryAt-Date.now()+50,2_000_000_000));
    return ()=>window.clearTimeout(timer);
  },[retryAt,waiting,now]);
  useEffect(()=>()=>controller.current?.abort(),[]);

  function changeSelection(next: string[]) {
    setSelected(next);
    try { localStorage.setItem(selectionKey, JSON.stringify(next)); }
    catch { setNotice("Не удалось сохранить выбранные направления."); }
  }

  async function start(saved?: DiscoveryQueue) {
    if (controller.current || retryAt > Date.now()) return;
    const next = saved ?? initialQueue(queries,selected.includes("all"));
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setNotice("");
    const checkpoint = (value: DiscoveryQueue) => {
      saveQueue(value);
      setQueue(value);
    };
    try {
      checkpoint(next);
      setNotice(await runDiscovery(next,abort.signal,index,checkpoint,setActivity));
    } catch (error) {
      setNotice(`Не удалось сохранить очередь поиска. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      controller.current = null;
      setRunning(false);
      setActivity("");
      setNow(Date.now());
    }
  }

  return <>
    <button className="primary" disabled={disabled} onClick={()=>dialog.current?.showModal()}>
      <Search size={16} aria-hidden="true"/> Найти новые макросы
    </button>
    <dialog ref={dialog} className="catalog-dialog discovery-dialog" aria-labelledby="discovery-title"
      onCancel={event=>{if (controller.current) event.preventDefault();}}>
      <div className="toolbar"><h2 id="discovery-title">Найти новые макросы</h2>
        <button disabled={running} onClick={()=>dialog.current?.close()}>Закрыть</button>
      </div>
      <div className="catalog-dialog-content">
        <div className="discovery-controls">
          <button disabled={running} onClick={()=>changeSelection(presets.map(preset=>preset.id))}>Выбрать все</button>
          <button disabled={running} onClick={()=>changeSelection([])}>Снять все</button>
        </div>
        <div className="discovery-presets" role="group" aria-label="Направления поиска">
          {presets.map(preset=>{
            const Icon = icons[preset.icon] ?? ScrollText;
            const checked = selected.includes(preset.id);
            return <label key={preset.id} className="discovery-preset">
              <input type="checkbox" disabled={running} checked={checked} onChange={event=>
                changeSelection(event.target.checked ? [...selected,preset.id] : selected.filter(id=>id!==preset.id))}/>
              <span className="macro-icon"><Icon size={18} aria-hidden="true"/></span>
              <span>{preset.title}</span>
            </label>;
          })}
        </div>
        <label>Дополнительный запрос<input maxLength={180} disabled={running} value={custom} onChange={event=>setCustom(event.target.value)}/></label>
        <details className="discovery-preview" open>
          <summary>Сформированные запросы ({queries.length})</summary>
          {queries.length ? <ol lang="en">{queries.map(query=><li key={query}>{query}</li>)}</ol> : <p>Выберите направление или введите запрос.</p>}
        </details>
        {queue && <div className="discovery-progress" role="status" aria-live="polite">
          <progress max={Math.max(1,queue.queries.length)} value={queue.queryIndex} aria-label="Запросы GitHub"/>
          <p>Запросы: {queue.queryIndex} из {queue.queries.length} · Проверено источников: {queue.processed.length} · В очереди: {queue.pending.length} · Найдено кандидатов: {queue.found}{queue.skipped ? ` · Пропущено источников: ${queue.skipped}` : ""}</p>
          {activity && <p>Обрабатывается: {activity}</p>}
          {notice && <p>{notice}</p>}
          {waiting && <p>Очередь сохранена. Продолжить можно после {new Date(retryAt).toLocaleTimeString("ru")}.</p>}
        </div>}
        {!queue && notice && <p role="alert">{notice}</p>}
        <div className="discovery-controls">
          {running ? <button onClick={()=>controller.current?.abort()}>Остановить поиск</button> : <>
            {unfinished && <button className="primary" disabled={waiting} onClick={()=>void start(queue)}>Продолжить поиск</button>}
            <button className={unfinished ? undefined : "primary"} disabled={!queries.length || waiting} onClick={()=>{
              if (!unfinished || confirm("Начать новый поиск и заменить сохранённую очередь?")) void start();
            }}>Начать поиск</button>
          </>}
        </div>
      </div>
    </dialog>
  </>;
}
