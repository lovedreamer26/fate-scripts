import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

type Report = {status?: string; error?: string; stack?: string; result?:unknown; durationMs?:number};
type LiveStatus = {
  status:string; origin?:string; worldId?:string;
  pairingIssue?: "worldMismatch" | "profileMismatch" | "bridgeVersion";
  operation?: {scriptId:string;snapshot:{status:string;result?:Report;persistence_error?:string}};
};

export const stateLabel:Record<string,string> = {
  idle:"Не сопряжён", pairing:"Ожидание GM", connected:"Подключён", offline:"Нет связи с GM",
  expired:"Срок истёк", waiting:"В очереди", claimed:"Выполняется",
  unknown:"Исход неизвестен", returned:"Вызов завершился", error:"Ошибка", cancelled:"Отменён",
};

export function useLiveBridge(){
  const [session,setSession]=useState<LiveStatus>({status:"idle"});
  useEffect(()=>{
    let active=true, busy=false;
    async function refresh(){
      if(busy)return;
      busy=true;
      try {
        const next=await invoke<LiveStatus>("live_status");
        if(active)setSession(next);
      } catch { if(active)setSession({status:"offline"}); }
      finally{busy=false;}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),750);
    return ()=>{active=false;window.clearInterval(timer);};
  },[]);
  return session;
}

export function LiveBridge(){
  const session=useLiveBridge();
  const [origin,setOrigin]=useState("http://localhost:30000");
  const [world,setWorld]=useState("");
  const [code,setCode]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  async function action(command:()=>Promise<void>){
    setBusy(true);setError("");
    try{await command();}catch(error){setError(String(error));}finally{setBusy(false);}
  }
  return <details><summary>Foundry — сессия GM</summary>
    <p role="status">{stateLabel[session.status]??session.status}{session.worldId&&` · ${session.worldId}`}</p>
    <input aria-label="Адрес Foundry для сопряжения" value={origin} onChange={event=>setOrigin(event.target.value)}/>
    <input aria-label="ID мира для сопряжения" placeholder="ID мира" value={world} onChange={event=>setWorld(event.target.value)}/>
    <button disabled={busy||!world.trim()||!["idle","expired"].includes(session.status)} onClick={()=>void action(async()=>{
      if(session.status==="expired")await invoke("live_revoke");
      setCode(await invoke<string>("live_pair",{origin:origin.trim(),world:world.trim()}));
    })}>Начать сопряжение</button>
    {code&&(session.status==="pairing"||session.status==="idle")&&<>
      <input aria-label="Одноразовый код сопряжения" readOnly value={code}/>
      <button onClick={()=>void action(()=>navigator.clipboard.writeText(code))}>Копировать</button>
      <p>В настройках Foundry выберите «Fate Scripts — сопряжение GM».</p>
    </>}
    {session.status!=="idle"&&<button disabled={busy} onClick={()=>void action(async()=>{
      await invoke("live_revoke");setCode("");
    })}>Отозвать сессию</button>}
    {session.status==="idle"&&<button disabled={busy||!origin} onClick={()=>void action(async()=>{
      if(confirm("Забыть идентификаторы миров Foundry для этого адреса?"))await invoke("live_forget_identity",{origin});
    })}>Забыть идентификатор</button>}
    {session.status==="pairing"&&session.pairingIssue&&<p role="status">
      {session.pairingIssue==="bridgeVersion"
        ? "Обновите Fate Scripts Bridge и перезагрузите клиент Foundry."
        : session.pairingIssue==="worldMismatch"
        ? "Foundry прислал другой ID мира. Проверьте открытый мир."
        : "Этот адрес закреплён за другой идентичностью Foundry. Чтобы сменить привязку, сначала отзовите сессию и забудьте идентификатор."}
    </p>}
    <p role="status">{error}</p>
  </details>;
}
