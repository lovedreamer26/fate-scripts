import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

export function LibraryBackup(){
  const [copies,setCopies]=useState<string[]>([]);
  const [name,setName]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  async function action(run:()=>Promise<void>){
    setBusy(true);
    try {await run();} catch(error){setNotice(String(error));}
    finally{setBusy(false);}
  }
  async function refresh(){setCopies(await invoke<string[]>("list_library_backups"));}
  useEffect(()=>{
    void invoke<string|null>("library_restore_notice").then(error=>{
      if(error)setNotice("Восстановление не завершилось: "+error);
    }).catch(error=>setNotice(String(error)));
  },[]);
  return <details onToggle={event=>{if(event.currentTarget.open)void action(refresh);}}>
    <summary>Резервные копии</summary>
    <button disabled={busy} onClick={()=>void action(async()=>{
      const copy=await invoke<string>("create_library_backup");
      await refresh();setName(copy);setNotice("Создана копия библиотеки: "+copy);
    })}>Создать копию</button>
    <select aria-label="Резервная копия" value={name} onChange={event=>setName(event.target.value)}>
      <option value="">Выберите копию</option>
      {copies.map(copy=><option key={copy}>{copy}</option>)}
    </select>
    <button disabled={busy||!name} onClick={()=>void action(async()=>{
      if(!confirm("При следующем запуске библиотека будет заменена выбранной копией. Перед заменой приложение сохранит текущую базу. Запланировать восстановление?"))return;
      await invoke("stage_library_restore",{name});
      setNotice("Восстановление запланировано на следующий запуск. Сохраните работу и закройте все окна приложения.");
    })}>Восстановить при запуске</button>
    <button disabled={busy} onClick={()=>void action(async()=>{
      await invoke("cancel_library_restore");setNotice("Запланированное восстановление отменено.");
    })}>Отменить восстановление</button>
    <p role="status">{notice}</p>
  </details>;
}
