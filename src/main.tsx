import { Swords, Sparkles, Users, WandSparkles, Map as MapIcon, Scan, Backpack, Shield, Settings2, ScrollText, type LucideIcon } from "lucide-react";
import { categories as macroCategories, classifyMacro, glossaryTitle, macroCandidate, systemFromPath, translationKey, UnsupportedMacroError, type Category, type Translation } from "./catalog-metadata";
import { parse } from "acorn";
import foundryMacroTypes from "./foundry-macro-globals.txt?raw";
import {LibraryBackup} from './LibraryBackup';
import {RunConsole} from './RunConsole';
import {LiveBridge,stateLabel,useLiveBridge} from './LiveBridge';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Deck } from "./Deck";
import { worldMatches } from "./deck-tools.mjs";
import { readCatalog, replaceRepository, dependencyIds } from "./catalog-cache.mjs";
import { repositoryName, filterCatalog, dependencyStatus, type ModuleSnapshot } from "./catalog-tools.mjs";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { formatScriptText, parseScriptText } from "./fate-script-text.mjs";
import { detectDependencies } from "./dependencies";
import { bundled, catalogSourceUrl, enrichCatalogEntry, markSourceChecked, refreshRepository, sourceCheckedAt, type CatalogEntry } from "./catalog";
import { CatalogSearchDialog } from "./catalog-search-dialog";
import { folderPath, folderTree, inFolder, redactSecrets, sameJsonValue } from "./library-tools.mjs";
import { scriptExport } from "./script-export";
import "./style.css";

Object.assign(globalThis, {
  MonacoEnvironment: { getWorker: (_: string, label: string) =>
    label === "javascript" || label === "typescript" ? new JsWorker() : new EditorWorker() },
});

const macroIcons: Record<Category, LucideIcon> = {
  "Сражения":Swords, "Заклинания":WandSparkles, "Персонажи":Users, "Анимации":Sparkles,
  "Карты и сцены":MapIcon, "Токены":Scan, "Предметы":Backpack, "Инструменты ГМ":Shield, "Системные":Settings2, "Прочее":ScrollText,
};
const systemName = (id?: string) => ({dnd5e:"D&D 5e",pf2e:"Pathfinder 2e",pf1:"Pathfinder 1e"}[id ?? ""] ?? id ?? "Система не указана");
const translationFields = z.object({
  title:z.string().max(200).optional(), description:z.string().max(4000).optional(),
  instructions:z.string().max(4000).optional(), requirements:z.string().max(4000).optional(), category:z.string().max(80).optional(),
});
function storedTranslations(): Record<string,Translation> {
  try {return z.record(z.string(),translationFields).parse(JSON.parse(localStorage.getItem("catalog.translations.v1") ?? "{}"));}
  catch {return {};}
}

type Script = {
  id: string; name: string; description: string; code: string;
  tags: string; category: string; folder: string; world: string; notes: string;
  provenance?: Omit<CatalogEntry, "code">;
  dependencies?: string;
  foundryVersion?: string;
  image?: string;
};
type ScriptDetails = {created: string; modified: string; origin?: string; worldId?: string; macroId?: string};

function ScriptCardImage({ image, onChange, onError }: {
  image?: string; onChange: (image?: string) => void; onError: (message: string) => void;
}) {
  function load(file?: File) {
    if (!file) return;
    if (file.size > 256000 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      onError("Допустимо изображение PNG, JPEG или WebP до 256 КБ.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") onChange(reader.result); };
    reader.onerror = () => onError("Не удалось прочитать изображение.");
    reader.readAsDataURL(file);
  }
  return <div className="script-card-image" onDragOver={event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  }} onDrop={event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    load(event.dataTransfer.files[0]);
  }}>
    {image && <img src={image} alt="Изображение скрипта"/>}
    <label className="file">Изображение скрипта<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      load(file);
    }}/></label>
    {image && <button onClick={() => onChange(undefined)}>Убрать изображение</button>}
  </div>;
}

type Version = { number: number; code: string; source: string; date: string };
type Review = { before: string; after: string; beforeLabel: string; afterLabel: string; actionLabel: string; accept: () => void };

let registeredMacroTypes = false;
const arcaneTheme: import("monaco-editor").editor.IStandaloneThemeData = {
  base: "vs-dark", inherit: true,
  rules: [{token: "comment", foreground: "9C94AF"}, {token: "keyword", foreground: "C4A7FF"}],
  colors: {"editor.background":"#101016","editor.foreground":"#EAE8F2","editorLineNumber.foreground":"#9C94AF","editor.lineHighlightBackground":"#191923","editor.selectionBackground":"#8B5CF64D","editorCursor.foreground":"#D4B478"},
};

function CodeView({ code, onChange, original, fontSize = 14 }: {
  code: string; onChange?: (value: string) => void; original?: string; fontSize?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<{updateOptions: (options: {fontSize: number}) => void}>(null);
  const latest = useRef({ code, original, onChange, fontSize });
  latest.current = { code, original, onChange, fontSize };
  const diff = original !== undefined;
  useEffect(() => {
    let dispose = () => {};
    let cancelled = false;
    void import("monaco-editor").then(({ editor, typescript, MarkerSeverity }) => {
      if (cancelled || !host.current) return;
      if (!registeredMacroTypes) {
        editor.defineTheme("arcane-studio", arcaneTheme);
        typescript.javascriptDefaults.addExtraLib(foundryMacroTypes, "file:///foundry-macro-globals.d.ts");
        typescript.javascriptDefaults.setDiagnosticsOptions({noSyntaxValidation: true, noSemanticValidation: true});
        registeredMacroTypes = true;
      }
      const modified = editor.createModel(latest.current.code, "javascript");
      if (diff) {
        const base = editor.createModel(latest.current.original ?? "", "javascript");
        const view = editor.createDiffEditor(host.current, { theme: "arcane-studio", automaticLayout: true, readOnly: true });
        view.setModel({ modified, original: base });
        dispose = () => { view.dispose(); base.dispose(); modified.dispose(); };
      } else {
        const view = editor.create(host.current, {
          model: modified, theme: "arcane-studio", automaticLayout: true, fontSize: latest.current.fontSize,
          minimap: { enabled: false }, readOnly: !latest.current.onChange,
        });
        viewRef.current = view;
        function validate(value: string) {
          try {
            parse(value, {ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true});
            editor.setModelMarkers(modified, "foundry-macro", []);
          } catch (error) {
            const syntax = error as {message: string; loc?: {line: number; column: number}};
            if (!syntax.loc) return;
            const {line, column} = syntax.loc;
            editor.setModelMarkers(modified, "foundry-macro", [{
              message: syntax.message, severity: MarkerSeverity.Error,
              startLineNumber: line, endLineNumber: line, startColumn: column + 1, endColumn: column + 2,
            }]);
          }
        }
        validate(modified.getValue());
        const listener = modified.onDidChangeContent(() => {
          const value = modified.getValue(0, true);
          latest.current.onChange?.(value);
          validate(value);
        });
        dispose = () => { viewRef.current = null; listener.dispose(); view.dispose(); modified.dispose(); };
      }
    });
    return () => { cancelled = true; dispose(); };
  }, [diff]);
  useEffect(() => viewRef.current?.updateOptions({fontSize}), [fontSize]);
  return <div ref={host} className={diff ? "code diff" : "code"} aria-label={diff ? "Сравнение JavaScript" : "Редактор JavaScript"} />;
}

const metadata = z.object({ name: z.string().min(1).optional(), description: z.string().optional(), tags: z.array(z.string()).optional() });
const fields = { name: "Название", folder: "Путь папки", category: "Категория", tags: "Теги", world: "Идентификатор мира", description: "Описание", notes: "Заметки" } as const;
const fresh = (name = "Новый скрипт", code = ""): Script => ({
  id: crypto.randomUUID(), name, code, description: "", tags: "", category: "", folder: "", world: "", notes: "",
});
function downloadScript(script: Script) {
  const {file, filename} = scriptExport(script.name, script.code);
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const report = (error: unknown) => error instanceof Error ? error.message : String(error);

type BridgeSnapshot = {operation?:string; runId?:string;status: string; inventory: null | {serverOrigin:string; worldId:string; macros: {id: string; name: string; type: string}[]}};
function FoundryReceiver({onImport}: {onImport: () => Promise<void>}) {
  const [origin,setOrigin]=useState("http://localhost:30000");
  const [worldId,setWorldId]=useState("");
  const [code,setCode]=useState("");
  const [snapshot,setSnapshot]=useState<BridgeSnapshot>({status:"idle",inventory:null});
  const [error,setError]=useState("");
  const [included,setIncluded]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(snapshot.status!=="waiting") return;
    let active=true;
    const timer=window.setInterval(()=>{void invoke<BridgeSnapshot>("bridge_status").then(value=>{if(active && value.operation==="inventory" && value.runId===snapshot.runId){setSnapshot(value);if(value.inventory)setIncluded(value.inventory.macros.filter(m=>m.type==="script").map(m=>m.id));if(value.status!=="waiting")setCode("");}}).catch(e=>{if(active)setError(report(e));});},1000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[snapshot.status,snapshot.runId]);
  async function start(){setBusy(true);setError("");try{const p=await invoke<{code:string;runId:string}>("bridge_start",{origin,worldId,request:null});setCode(p.code);setSnapshot({status:"waiting",runId:p.runId,inventory:null});}catch(e){setError(report(e));}finally{setBusy(false);}}
  async function cancel(){if(!snapshot.runId)return;setBusy(true);try{await invoke("bridge_cancel",{operation:"inventory",runId:snapshot.runId});setCode("");setSnapshot({status:"idle",inventory:null});}catch(e){setError(report(e));}finally{setBusy(false);}}
  async function accept(){if(!snapshot.inventory||!snapshot.runId||!included.length||!confirm("Импортировать выбранные новые макросы? Существующие записи не изменятся."))return;setBusy(true);try{const r=await invoke<{imported:number;skipped:number}>("import_foundry_inventory",{inventory:{...snapshot.inventory,macros:snapshot.inventory.macros.filter(m=>included.includes(m.id))}});await invoke("bridge_cancel",{operation:"inventory",runId:snapshot.runId});setSnapshot({status:"idle",inventory:null});await onImport();setError(`Импортировано: ${r.imported}; пропущено: ${r.skipped}`);}catch(e){setError(report(e));}finally{setBusy(false);}}
  return <details><summary>Foundry Bridge — прямой импорт</summary><p>Укажите точный адрес Foundry и ID мира. В сессии GM нажмите Ctrl+Shift+F10 и введите код.</p><input aria-label="Origin Foundry" value={origin} onChange={e=>setOrigin(e.target.value)} disabled={busy||snapshot.status==="waiting"}/><input aria-label="ID мира" placeholder="ID мира" value={worldId} onChange={e=>setWorldId(e.target.value)} disabled={busy||snapshot.status==="waiting"}/><button disabled={busy||!worldId||snapshot.status==="waiting"} onClick={()=>void start()}>Получить код</button><button disabled={busy} onClick={()=>void cancel()}>Отмена</button>{code&&<><input aria-label="Код сопряжения" readOnly value={code}/><button onClick={()=>void navigator.clipboard.writeText(code).catch(e=>setError(report(e)))}>Копировать код</button></>}<p role="status">{({idle:"Не подключено",waiting:"Ожидание GM (до 120 секунд)",received:"Снимок получен",expired:"Код истёк"} as Record<string,string>)[snapshot.status]??snapshot.status}</p>{snapshot.inventory&&<><p>{snapshot.inventory.serverOrigin} / {snapshot.inventory.worldId}: {snapshot.inventory.macros.length} макросов</p><button disabled={busy} onClick={()=>setIncluded(snapshot.inventory!.macros.filter(m=>m.type==="script").map(m=>m.id))}>Выбрать все скрипты</button><button disabled={busy} onClick={()=>setIncluded([])}>Снять выделение</button><ul className="foundry-macro-picker">{snapshot.inventory.macros.filter(m=>m.type==="script").map(m=><li key={m.id}><label><input type="checkbox" checked={included.includes(m.id)} onChange={e=>setIncluded(previous=>e.target.checked?[...previous,m.id]:previous.filter(id=>id!==m.id))}/>{m.name}</label></li>)}</ul><button disabled={busy||!included.length} onClick={()=>void accept()}>Импортировать выбранные ({included.length})</button></>}<p role="status">{error}</p></details>;
}

function FoundryRunner({script, inventory}: {script?: Script; inventory: ModuleSnapshot|null}) {
  const [origin,setOrigin]=useState("http://localhost:30000");
  const [worldId,setWorldId]=useState("");
  const [macroId,setMacroId]=useState("");
  const [message,setMessage]=useState("");
  const [code,setCode]=useState("");
  const [pending,setPending]=useState(false);
  const [result,setResult]=useState("");
  const [runId,setRunId]=useState("");
  const [history,setHistory]=useState<unknown[]>([]);
  useEffect(()=>{
    if(!pending || !runId)return;
    let active=true;
    const timer=window.setInterval(()=>{
      void invoke<{operation?:string;runId?:string;status:string;result?:unknown;persistence_error?:string}>("bridge_status").then(snapshot=>{
        if(!active||snapshot.operation!=="run"||snapshot.runId!==runId)return;
        if(snapshot.persistence_error)setMessage(snapshot.persistence_error);
        if(!["reported","expired","unknown"].includes(snapshot.status))return;
        setMessage(snapshot.persistence_error??snapshot.status);
        if(snapshot.result)setResult(JSON.stringify(snapshot.result,null,2));
        setPending(false);
        setCode("");
      }).catch(error=>{if(active)setMessage(report(error));});
    },1000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[pending,runId]);
  async function prepare(){
    if(!script||!worldId||pending)return;
    if(!worldMatches(script.world,origin,worldId)){setMessage("Скрипт принадлежит другому миру или серверу.");return;}
    let warning = "";
    try { const rows = dependencyStatus([...detectDependencies(script.code), ...dependencyIds(script.dependencies ?? "")], inventory, origin, worldId); warning = rows.map(r=>`${r.id}: ${({active:"Активен",inactive:"Отключён",missing:"Отсутствует в снимке",unknown:"Нет данных"} as Record<string,string>)[r.status] ?? r.status} ${r.version}`).join("\n"); } catch(e) { warning = "Анализ зависимостей не выполнен: " + report(e); }
    if(!confirm("Выполнение может изменить игровые данные. Совместимость модулей не подтверждена.\n"+warning+"\nПодготовить запрос?"))return;
    setPending(true);
    try {const rid=crypto.randomUUID();setRunId(rid);const p=await invoke<{code:string}>("bridge_start",{origin,worldId,request:{protocol:4,runId:rid,origin,worldId,action:macroId?"existing":"test",name:script.name,macroId,expected:script.code,code:script.code}});setCode(p.code);setResult("");setMessage("В Foundry нажмите Ctrl+Shift+F8 и введите код.");}catch(e){setPending(false);setMessage(report(e));}
  }
  async function check(){try{const s=await invoke<{operation?:string;runId?:string;status:string;result?:unknown}>("bridge_status");if(s.operation!=="run"||s.runId!==runId){setMessage("Запрос больше не принадлежит этому окну; результат неизвестен.");setPending(false);setCode("");return;}setMessage(s.status);if(s.result)setResult(JSON.stringify(s.result,null,2));if(["reported","expired","unknown","idle","received"].includes(s.status)){setPending(false);setCode("");}}catch(e){setMessage(report(e));}}
  return <details><summary>Foundry — прямой запуск</summary><input aria-label="Адрес запуска" value={origin} disabled={pending} onChange={e=>setOrigin(e.target.value)}/><input placeholder="ID мира" value={worldId} disabled={pending} onChange={e=>setWorldId(e.target.value)}/><input placeholder="ID макроса (пусто — тест)" value={macroId} disabled={pending} onChange={e=>setMacroId(e.target.value)}/><button disabled={!script||!worldId||pending} onClick={()=>void prepare()}>Подготовить запуск</button>{code&&<input readOnly value={code} aria-label="Код сопряжения запуска"/>}<button disabled={!pending} onClick={()=>void check()}>Получить состояние и отчёт</button><p role="status">{message}</p><pre>{result}</pre><button onClick={()=>void invoke<unknown[]>("list_run_reports").then(setHistory).catch(e=>setMessage(report(e)))}>История запусков</button><pre>{JSON.stringify(history,null,2)}</pre></details>;
}

function FoundryWriter({script}: {script?: Script}) {
  const live=useLiveBridge();
  const [origin,setOrigin]=useState("http://localhost:30000");
  const [worldId,setWorldId]=useState("");
  const [macroId,setMacroId]=useState("");
  const [expected,setExpected]=useState("");
  const [message,setMessage]=useState("");
  const [pending,setPending]=useState(false);
  const [pairing,setPairing]=useState("");

  const [writeId,setWriteId]=useState("");
  async function copy(){
    if(!script || !worldId || pending || !confirm("Подготовить запись? В Foundry потребуется подтверждение GM."))return;
    if(!worldMatches(script.world,origin,worldId)){setMessage("Скрипт принадлежит другому миру или серверу.");return;}
    setPending(true);
    try {const rid=crypto.randomUUID();setWriteId(rid);const p=await invoke<{code:string}>("bridge_start",{origin,worldId,request:{protocol:3,runId:rid,origin,worldId,action:macroId?"update":"create",scriptId:script.id,macroId,expected,name:script.name,code:script.code}});setPairing(p.code);setMessage("В Foundry нажмите Ctrl+Shift+F7 и введите код.");}catch(e){setPending(false);setMessage(report(e));}
  }
  async function check(){try{const s=await invoke<{operation?:string;runId?:string;status:string;result?:{status:string;id?:string}}>("bridge_status");if(s.operation!=="write"||s.runId!==writeId){setMessage("Запрос больше не принадлежит этому окну; результат неизвестен.");setPending(false);setPairing("");return;}setMessage(JSON.stringify(s.result??s.status));if(["reported","expired","unknown"].includes(s.status)){setPending(false);setPairing("");}}catch(e){setMessage(report(e));}}
  async function writeLive(){
    if(!script||!live.origin||!live.worldId||live.status!=="connected")return;
    if(!worldMatches(script.world,live.origin,live.worldId)){setMessage("Скрипт принадлежит другому миру или серверу.");return;}
    if(!confirm(`Передать сохранённую версию в ${live.worldId}? В Foundry потребуется подтверждение GM.`))return;
    try{
      const runId=crypto.randomUUID();
      await invoke("live_enqueue",{scriptId:script.id,runId,write:{macroId,expected}});
      setMessage("Ожидается подтверждение записи в Foundry.");
    }catch(error){setMessage(report(error));}
  }
  const snapshot=live.operation?.scriptId===script?.id?live.operation?.snapshot:undefined;
  const liveResult=snapshot?.result?.status??snapshot?.status;
  return <details><summary>Foundry — прямая запись</summary><p>Для обновления укажите ID и точный текущий код макроса.</p><input disabled={pending} aria-label="Адрес Foundry" value={origin} onChange={e=>setOrigin(e.target.value)}/><input disabled={pending} placeholder="ID мира" value={worldId} onChange={e=>setWorldId(e.target.value)}/><input disabled={pending} placeholder="ID макроса (пусто — создание)" value={macroId} onChange={e=>setMacroId(e.target.value)}/>{macroId&&<textarea disabled={pending} aria-label="Текущий код Foundry" value={expected} onChange={e=>setExpected(e.target.value)}/>}
    {live.status==="connected"?<button disabled={!script} onClick={()=>void writeLive()}>Передать через сессию GM</button>:<button disabled={!script||!worldId||pending} onClick={()=>void copy()}>Подготовить запись</button>}
    {pairing&&<input readOnly value={pairing}/>}<button disabled={!pending} onClick={()=>void check()}>Получить отчёт</button><p role="status">{message}</p>
    {liveResult&&<p>{stateLabel[liveResult]??liveResult}</p>}</details>;
}

function SendToFoundry({script, unsaved}: {script: Script; unsaved: boolean}) {
  const live = useLiveBridge();
  const sending = useRef(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const status = live.operation?.snapshot.status;
  const busy = status === "waiting" || status === "claimed";
  const own = live.operation?.scriptId === script.id ? live.operation.snapshot : undefined;
  async function send() {
    if (sending.current || unsaved || busy || live.status !== "connected") return;
    sending.current = true;
    setSubmitting(true);
    setError("");
    try {
      await invoke("live_enqueue", {scriptId: script.id, runId: crypto.randomUUID(), write: {linked: true}});
    } catch (error) {
      setError(report(error));
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }
  const result = own?.result?.status ?? own?.status;
  const disabledReason = unsaved ? "Сначала сохраните скрипт." :
    live.status !== "connected" ? "Подключите сессию GM в разделе Foundry." : "";
  return <>
    <button className="foundry-send" disabled={Boolean(disabledReason) || busy || submitting} title={disabledReason} onClick={() => void send()}>Отправить в Foundry</button>
    {error && <span role="status">{error}</span>}
    {result && <span role="status">{result === "written" ? "Макрос записан" : stateLabel[result] ?? result}{own?.result?.error && ` · ${own.result.error}`}</span>}
  </>;
}

function App() {
  const connection = useLiveBridge();
  const [storedFolders, setStoredFolders] = useState<{world: string; path: string}[]>([]);
  const [newFolder, setNewFolder] = useState("");
  const [scripts, setScripts] = useState<Script[]>([]);
  const [tabs, setTabs] = useState<Script[]>([]);
  const [id, setId] = useState("");
  const [search, setSearch] = useState("");
  const [world, setWorld] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [editorFont, setEditorFont] = useState(() => {
    const saved = Number(localStorage.getItem("fate-scripts.editor-font"));
    return saved >= 10 && saved <= 28 ? saved : 14;
  });
  const [message, setMessage] = useState("");
  const [input, setInput] = useState("");
  const [outgoing, setOutgoing] = useState("");
  const [diagnosticContext, setDiagnosticContext] = useState("");
  useEffect(() => {
    setInput("");
    setOutgoing("");
    setDiagnosticContext("");
  }, [id]);
  const [exchange, setExchange] = useState(false);
  const [raw, setRaw] = useState(false);
  const [review, setReview] = useState<Review>();
  const [history, setHistory] = useState<{scriptId: string; versions: Version[]}>();
  const historyRequest = useRef(0);
  const versions = history?.scriptId === id ? history.versions : [];
  async function loadHistory(scriptId: string) {
    const request = ++historyRequest.current;
    try {
      const versions = await invoke<Version[]>("list_versions", {id: scriptId});
      if (request === historyRequest.current) setHistory({scriptId, versions});
    } catch (error) {
      if (request === historyRequest.current) setMessage(report(error));
    }
  }
  function resetHistory() {
    historyRequest.current++;
    setHistory(undefined);
  }
  const [compare, setCompare] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [requirements, setRequirements] = useState("");
  const [catalog, setCatalog] = useState(false);
  const [deck,setDeck]=useState(false);
  const [deckScript,setDeckScript]=useState("");
  const [repository, setRepository] = useState("thejoester/foundryvtt-macros");
  const [online, setOnline] = useState<CatalogEntry[]>([]);
  const [catalogSources,setCatalogSources]=useState<string[]>([]);
  const [catalogLoaded,setCatalogLoaded]=useState(false);
  const catalogCache = useRef<{entries: CatalogEntry[]; sources: string[]}>({entries:[],sources:[]});
  const [previewed, setPreviewed] = useState<CatalogEntry>();
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogQuery,setCatalogQuery]=useState("");
  const [catalogRepo,setCatalogRepo]=useState("");
  const [catalogLicense,setCatalogLicense]=useState("");
  const [catalogSystem,setCatalogSystem]=useState("");
  const [catalogCategory,setCatalogCategory]=useState("");
  const [catalogSort,setCatalogSort]=useState("name");
  const [catalogUpdated,setCatalogUpdated]=useState(0);
  const [catalogTab,setCatalogTab]=useState<"metadata"|"code">("metadata");
  const [catalogError,setCatalogError]=useState("");
  const [translations,setTranslations]=useState(storedTranslations);
  const sourceDialog=useRef<HTMLDialogElement>(null);
  const macroDialog=useRef<HTMLDialogElement>(null);
  const openingMacro=useRef(false);
  const [inventory,setInventory]=useState<ModuleSnapshot|null>(null);
  const localized = (entry: CatalogEntry): CatalogEntry => {
    const original = entry.original ?? {title:entry.name, description:entry.description};
    const system = entry.system ?? systemFromPath(entry.path);
    const fallback = classifyMacro(original,entry.path);
    const translated = {title:glossaryTitle(entry.name),...entry.translated,...translations[translationKey(entry.repo,entry.path,original)]};
    const translatedCategory = macroCategories.find(category=>category===translated.category);
    return {
      ...entry, original, system, inferredSystem:entry.inferredSystem ?? Boolean(system && !original.system),
      category:translatedCategory ?? entry.category ?? fallback.category,
      inferredCategory:entry.inferredCategory ?? fallback.inferredCategory,
      translated,
    };
  };
  const allCatalog=[...bundled,...online.filter(entry=>!entry.unsupported && macroCandidate(entry.path) &&
    !bundled.some(item=>item.repo===entry.repo && item.path===entry.path && item.commit===entry.commit))].map(localized);
  const visibleCatalog = filterCatalog(allCatalog,catalogQuery,catalogRepo,catalogLicense)
    .filter(entry=>(!catalogSystem || (entry.system ?? "-")===catalogSystem) &&
      (!catalogCategory || entry.category===catalogCategory))
    .sort((a,b)=>(catalogSort==="date" ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") : 0) ||
      (a.translated?.title || a.name).localeCompare(b.translated?.title || b.name,"ru"));
  const detail = previewed && localized(previewed);
  useEffect(()=>{
    let active=true;
    async function load(){
      try {
        type Source={repo:string;entries:CatalogEntry[]};
        const legacy=readCatalog(localStorage);
        if(legacy.length){
          const sources=new Map<string,Source>();
          for(const entry of legacy){
            const key=entry.repo.toLowerCase();
            const source=sources.get(key)??{repo:entry.repo,entries:[]};
            source.entries.push(entry);sources.set(key,source);
          }
          await invoke("import_catalog_sources",{sources:[...sources.values()]});
        }
        const saved=await invoke<Source[]>("load_catalog");
        if(active){
          catalogCache.current={entries:saved.flatMap(source=>source.entries),sources:saved.map(source=>source.repo)};
          setOnline(catalogCache.current.entries);
          setCatalogSources(catalogCache.current.sources);
          setCatalogLoaded(true);
        }
      } catch(error){if(active)setMessage(report(error));}
    }
    void load();
    return ()=>{active=false;};
  },[]);
  async function cacheCatalog(repo:string, entries:CatalogEntry[]) {
    const matches = (name: string) => name.toLowerCase()===repo.toLowerCase();
    const incoming = entries.filter(entry=>matches(entry.repo));
    await invoke("save_catalog_source",{source:{repo,entries:incoming}});
    const current = catalogCache.current;
    catalogCache.current = {
      entries:[...current.entries.filter(entry=>!matches(entry.repo)),...incoming],
      sources:current.sources.some(matches)?current.sources:[...current.sources,repo],
    };
    setOnline(catalogCache.current.entries);
    setCatalogSources(catalogCache.current.sources);
  }
  async function indexDiscoveredRepository(found: string, signal: AbortSignal) {
    const current = catalogCache.current;
    const existing = current.sources.find(source=>source.toLowerCase()===found.toLowerCase());
    const repo = existing ?? found;
    const cached = existing ? current.entries.filter(entry=>entry.repo.toLowerCase()===repo.toLowerCase()) : undefined;
    const result = await refreshRepository(repo,cached,signal);
    signal.throwIfAborted();
    if (result.entries !== cached) await cacheCatalog(repo,replaceRepository(current.entries,repo,result.entries));
    markSourceChecked(repo,result.state);
    setCatalogUpdated(value=>value+1);
    return result.entries.filter(entry=>!entry.unsupported).length;
  }
  async function refreshCatalog() {
    if (catalogBusy) return;
    setCatalogBusy(true); setCatalogError("");
    try {
      const repo=repositoryName(repository);
      const cached=catalogSources.includes(repo) ? online.filter(entry=>entry.repo===repo) : undefined;
      const result=await refreshRepository(repo,cached);
      await cacheCatalog(repo,replaceRepository(online,repo,result.entries));
      markSourceChecked(repo,result.state);
      setCatalogUpdated(value=>value+1);
    } catch(error) {
      setCatalogError(`${report(error)} Сохранённый каталог доступен.`);
    } finally {setCatalogBusy(false);}
  }

  async function inspectMacro(entry: CatalogEntry, importDirect = false) {
    if (openingMacro.current) return;
    openingMacro.current = true;
    setCatalogTab("metadata"); setPreviewed(entry); setCatalogError(""); setCatalogBusy(true);
    if (!importDirect) macroDialog.current?.showModal();
    try {
      const next = await enrichCatalogEntry(entry);
      if (importDirect) importMacro(next);
      else setPreviewed(next);
      if (online.some(old=>old.path===entry.path && old.repo===entry.repo && old.commit===entry.commit)) {
        await cacheCatalog(entry.repo,online.map(old=>old.path===entry.path && old.repo===entry.repo && old.commit===entry.commit ? next : old));
      }
    } catch(error) {
      setCatalogError(report(error));
      if (error instanceof UnsupportedMacroError) {
        try { await cacheCatalog(entry.repo,online.map(old=>old.path===entry.path && old.repo===entry.repo && old.commit===entry.commit ? {...old,unsupported:true} : old)); }
        catch (cacheError) {setCatalogError(report(cacheError));}
      }
    }
    finally {openingMacro.current=false;setCatalogBusy(false);}
  }

  function importMacro(entry: CatalogEntry) {
    if (entry.code === undefined || !entry.enriched) return;
    if (!confirm(`Импортировать независимую копию? Лицензия файла: ${entry.license}. Совместимость с Foundry v14 не подтверждена.`)) return;
    const {code,...provenance}=localized(entry);
    open({...fresh(provenance.translated?.title || entry.name,code),description:provenance.translated?.description || entry.description,
      category:entry.category ?? "",provenance,world,folder:folder ?? ""});
    macroDialog.current?.close();
    setCatalog(false);
  }

  useEffect(()=>{let active=true; const timer=window.setInterval(()=>{void invoke<ModuleSnapshot | null>("bridge_module_inventory").then(snapshot=>{if(active) setInventory(snapshot);}).catch(()=>{});},1500);return()=>{active=false;window.clearInterval(timer);};},[]);
  const saving = useRef(false);
  const script = tabs.find((tab) => tab.id === id);
  const [details, setDetails] = useState<ScriptDetails | null>(null);
  useEffect(() => {
    let active = true;
    setDetails(null);
    if (id) void invoke<ScriptDetails | null>("script_details", {id}).then(value => {
      if (active) setDetails(value);
    }).catch(error => { if (active) setMessage(report(error)); });
    return () => {active = false;};
  }, [id, scripts]);
  const dirty = (tab: Script) => !sameJsonValue(tab,scripts.find(saved=>saved.id===tab.id));
  const query = search.trim().toLocaleLowerCase("ru");
  const visible = scripts.filter((entry) => (world === entry.world || (!entry.world && folder === null)) && inFolder(entry, folder) && (!category || entry.category === category) &&
    [entry.name, entry.folder, entry.category, entry.tags, entry.description].some((value) => value.toLocaleLowerCase("ru").includes(query)));
  const worlds = [...new Set([...scripts, ...storedFolders].map((entry) => entry.world).filter(Boolean))];
  const folders = folderTree([...scripts, ...storedFolders.map(f => ({world: f.world, folder: f.path}))], world);
  const categories = [...new Set(scripts.map(entry => entry.category).filter(Boolean))].sort();

  async function refresh() {
    const [entries, paths] = await Promise.all([invoke<Script[]>("list_scripts"), invoke<{world: string; path: string}[]>("list_folders")]);
    setScripts(entries); setStoredFolders(paths);
  }
  useEffect(() => { void refresh().catch((error) => setMessage(report(error))); }, []);

  function open(entry: Script) {
    setTabs((previous) => previous.some((tab) => tab.id === entry.id) ? previous : [...previous, entry]);
    setId(entry.id);
    resetHistory();
    setCompare("");
  }
  function edit(entry: Script) {
    setTabs((previous) => previous.map((tab) => tab.id === entry.id ? entry : tab));
  }
  async function save(entry: Script, source = "Редактор", closeReview = false) {
    if (saving.current) return;
    saving.current = true;
    try {
      const original = entry;
      entry = {...entry, folder: folderPath(entry.folder)};
      await invoke("save_script", { script: entry, source, expectedCode: scripts.find((saved) => saved.id === entry.id)?.code ?? null });
      if (!closeReview) setTabs(previous => previous.map(tab => tab === original ? entry : tab));
      if (closeReview) {
        edit(entry);
        setEditorRevision((value) => value + 1);
        setReview(undefined);
        setExchange(false);
      }
      await refresh();
      if (history?.scriptId === entry.id) await loadHistory(entry.id);
      setMessage("Сохранено");
    } catch (error) { setMessage(report(error)); }
    finally { saving.current = false; }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (script && !review) void save(script);
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (tabs.some(dirty)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("beforeunload", unload); };
  });

  function preview() {
    if (!script) return;
    try {
      const parsed = parseScriptText(input, { raw });
      const meta = metadata.parse(parsed.metadata);
      const next = { ...script, ...meta, tags: meta.tags?.join(", ") ?? script.tags, code: parsed.code };
      setReview({ before: script.code, after: next.code, beforeLabel: "Текущий редактор", afterLabel: "Ответ ChatGPT", actionLabel: "Принять и сохранить", accept: () => void save(next, "ChatGPT", true) });
    } catch (error) { setMessage(report(error)); }
  }

  async function changeFolder(remove: boolean) {
    if (!folder || saving.current) return;
    if (tabs.some(dirty)) { setMessage("Сначала сохраните открытые скрипты."); return; }
    const target = remove ? null : prompt("Новый полный путь папки", folder);
    if (!remove && target === null) return;
    if (remove && !confirm("Удалить пустое дерево папок?")) return;
    saving.current = true;
    try {
      await invoke("change_folder", {world, path: folder, target});
      setTabs([]); setId(""); setReview(undefined); resetHistory(); setCompare("");
      setFolder(target); setSelected([]); await refresh();
      setMessage("Структура папок обновлена");
    } catch (error) { setMessage(report(error)); }
    finally { saving.current = false; }
  }

  const draggedScripts = useRef<string[]>([]);
  async function organize(ids: string[], destination: {world: string; path: string} | null, category: string | null) {
    if (!ids.length || saving.current) return;
    if (tabs.some(tab => ids.includes(tab.id) && dirty(tab))) {
      setMessage("Сохраните выбранные открытые скрипты перед переносом или сменой категории.");
      return;
    }
    if (destination && scripts.some(entry => ids.includes(entry.id) && entry.world !== destination.world)
        && !confirm("Перенести скрипты в другой мир? Прежние связи этих скриптов с макросами Foundry будут сняты.")) return;
    saving.current = true;
    try {
      await invoke("organize_scripts", {ids, destination, category});
      const latest = await invoke<Script[]>("list_scripts");
      setTabs(previous => previous.map(tab => {
        const saved = ids.includes(tab.id) ? latest.find(entry => entry.id === tab.id) : undefined;
        if (!saved) return tab;
        return {...tab,
          ...(destination ? {world: saved.world, folder: saved.folder} : {}),
          ...(category !== null ? {category: saved.category} : {}),
        };
      }));
      await refresh();
      setSelected([]);
      setMessage(`Обновлено скриптов: ${ids.length}`);
    } catch (error) { setMessage(report(error)); }
    finally { saving.current = false; }
  }

  function folderDrop(path: string) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (draggedScripts.current.length) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }
      },
      onDrop: (event: React.DragEvent) => {
        if (!draggedScripts.current.length) return;
        event.preventDefault();
        const ids = draggedScripts.current;
        draggedScripts.current = [];
        void organize(ids, {world, path}, null);
      },
    };
  }

  async function removeSelected() {
    if (!selected.length || !confirm("Удалить выбранные локальные скрипты и их историю?")) return;
    try {
      await invoke("delete_scripts", { ids: selected });
      setTabs((previous) => previous.filter((tab) => !selected.includes(tab.id)));
      setSelected([]);
      await refresh();
    } catch (error) { setMessage(report(error)); }
  }

  return <main>
    <header className="studio-header"><div className="brand"><span className="brand-mark" aria-hidden="true">✦</span><div><strong>Fate Scripts</strong><small>Fate &amp; Roll</small></div></div>
      <output role="status">{message}</output>
      <div className="connection-pill" data-status={connection.status} role="status">
        <span className="connection-dot" aria-hidden="true"/><strong>Foundry</strong>
        <span>{stateLabel[connection.status] ?? connection.status}{connection.worldId && ` · ${connection.worldId}`}</span>
      </div>
    </header>
    <aside className="studio-sidebar">
      <div className="side-nav" role="navigation" aria-label="Разделы Fate Scripts">
        <button className="primary" onClick={() => { setDeck(false); setCatalog(false); open({ ...fresh(), world, folder: folder ?? "" }); }}><span aria-hidden="true">＋</span>Новый скрипт</button>
        <button aria-pressed={!deck && !catalog} onClick={() => {setDeck(false);setCatalog(false)}}><span aria-hidden="true">▤</span>Библиотека</button>
        <button aria-pressed={catalog} onClick={() => {setDeck(false);setCatalog(!catalog)}}><span aria-hidden="true">◇</span>Каталог GitHub</button>
        <button aria-pressed={deck} onClick={() => {setDeck(!deck);setCatalog(false)}}><span aria-hidden="true">▦</span>Панель запуска</button>
        <button onClick={()=>void invoke("open_deck_window").catch(e=>setMessage(report(e)))}><span aria-hidden="true">↗</span>Отдельное окно</button>
      </div>
      <details className="technical"><summary>Foundry и настройки</summary>
      <LiveBridge/>
      <label className="file">Импорт снимка Foundry<input type="file" accept=".json" onChange={async event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (!file) return;
        try {
          if (file.size > 16 * 1024 * 1024) throw new Error("Снимок слишком большой.");
          const inventory = JSON.parse(await file.text());
          if (inventory?.protocol !== 2 || !Array.isArray(inventory.macros)) throw new Error("Некорректный снимок.");
          if (!window.confirm(`Импортировать новые JavaScript-макросы из ${inventory.serverOrigin}, мир ${inventory.worldId}? Существующие записи не изменятся.`)) return;
          const result = await invoke<{imported:number;skipped:number}>("import_foundry_inventory", {inventory});
          await refresh(); setMessage(`Импортировано: ${result.imported}; пропущено: ${result.skipped}`);
        } catch(error) { setMessage(report(error)); }
      }} /></label>
      <label className="file">Импорт .js<input type="file" accept=".js,.mjs,.cjs" multiple onChange={async (event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        try {
          for (const file of files) {
            const value = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(await file.arrayBuffer());
            open({...fresh(file.name.replace(/\.[^.]+$/, ""), value), world, folder: folder ?? ""});
          }
        } catch (error) { setMessage(report(error)); }
      }} /></label>
      <RunConsole onPrepare={context => {
      if (!script) { setMessage("Откройте скрипт, для которого нужен отчёт."); return; }
      setDeck(false);
      setCatalog(false);
      setDiagnosticContext(context);
      setOutgoing("");
      setExchange(true);
    }}/><LibraryBackup/><FoundryReceiver onImport={refresh}/><FoundryWriter script={script}/><FoundryRunner script={script} inventory={inventory}/></details><h2>Мои скрипты</h2>
      <input placeholder="Поиск по библиотеке" aria-label="Поиск по библиотеке" value={search} onChange={(event) => {setSearch(event.target.value); setSelected([]);}} />
      <select aria-label="Мир" value={world} onChange={(event) => { setWorld(event.target.value); setFolder(null); setSelected([]); }}>
        <option value="">Общие скрипты</option>{worlds.map((value) => <option key={value}>{value}</option>)}
      </select>
      <select aria-label="Категория" value={category} onChange={event => {setCategory(event.target.value); setSelected([]);}}><option value="">Все категории</option>{categories.map(value => <option key={value}>{value}</option>)}</select>
      <div className="row create-folder"><input aria-label="Имя новой папки" placeholder="Новая папка" value={newFolder} onChange={e => setNewFolder(e.target.value)} /><button disabled={!newFolder.trim()} onClick={async () => {
        try { const path = folderPath([folder, newFolder].filter(Boolean).join("/")); await invoke("create_folder", {world, path}); await refresh(); setFolder(path); setNewFolder(""); setSelected([]); } catch (error) { setMessage(report(error)); }
      }}>Создать</button></div>
      <div className="row"><button disabled={!folder} onClick={() => void changeFolder(false)}>Переименовать / переместить</button><button disabled={!folder} onClick={() => void changeFolder(true)}>Удалить пустую папку</button></div>
      <div className="folder-tree"><button aria-current={folder === null} onClick={() => {setFolder(null); setSelected([]);}}>Все папки</button><button {...folderDrop("")} aria-current={folder === ""} onClick={() => {setFolder(""); setSelected([]);}}>Без папки</button>{folders.map(path => <button {...folderDrop(path)} key={path} aria-current={folder === path} style={{paddingInlineStart: 12 + 9 * Math.min(8, path.split('/').length - 1)}} onClick={() => {setFolder(path); setSelected([]);}}>{path.split('/').slice(-1)[0]}</button>)}</div>
      {visible.map((entry) => <div className="row" key={entry.id}>
        <input type="checkbox" aria-label={`Выбрать ${entry.name}`} checked={selected.includes(entry.id)}
          onChange={(event) => setSelected(event.target.checked ? [...selected, entry.id] : selected.filter((item) => item !== entry.id))} />
        <button draggable onDragStart={event => {
          draggedScripts.current = selected.includes(entry.id) ? selected : [entry.id];
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-fate-scripts", entry.id);
        }} onDragEnd={() => { draggedScripts.current = []; }} aria-current={id === entry.id} onClick={() => { setDeck(false); setCatalog(false); open(entry); }}>{entry.name}<small>{entry.folder}</small></button>
      </div>)}
      {visible.length > 0 && <button onClick={() => setSelected(visible.map(entry => entry.id))}>Выбрать видимые</button>}
      {selected.length > 0 && <div className="toolbar">
        <button onClick={() => {
          const targetWorld = prompt("ID игрового мира. Пустое поле — общая библиотека.", world);
          if (targetWorld === null) return;
          const path = prompt("Путь папки назначения", folder ?? "");
          if (path !== null) void organize(selected, {world: targetWorld.trim(), path}, null);
        }}>Переместить выбранные</button>
        <button onClick={() => {
          const value = prompt("Категория. Пустое поле снимает категорию.");
          if (value !== null) void organize(selected, null, value);
        }}>Категория выбранных</button>
        <button onClick={() => void removeSelected()}>Удалить выбранные ({selected.length})</button>
        <button onClick={() => setSelected([])}>Снять выделение</button>
      </div>}
    </aside>
    {deck ? <section className="workspace deck-workspace"><Deck scripts={scripts} onSelect={setDeckScript}/><h2>Выбранный скрипт: {scripts.find(s=>s.id===deckScript)?.name??"—"}</h2></section> : catalog ? <section className="workspace catalog">
      <div className="catalog-heading"><h1>Каталог макросов</h1><div className="catalog-heading-actions">
        <CatalogSearchDialog index={indexDiscoveredRepository} disabled={catalogBusy || !catalogLoaded}/>
        <button onClick={()=>{setCatalogError("");sourceDialog.current?.showModal()}}>Источники GitHub</button>
      </div></div>
      <div className="toolbar catalog-filters">
        <input aria-label="Поиск макросов" placeholder="Поиск макросов" value={catalogQuery} onChange={e=>setCatalogQuery(e.target.value)}/>
        <select aria-label="Репозиторий" value={catalogRepo} onChange={e=>setCatalogRepo(e.target.value)}><option value="">Все репозитории</option>{[...new Set(allCatalog.map(e=>e.repo))].map(r=><option key={r}>{r}</option>)}</select>
        <select aria-label="Игровая система" value={catalogSystem} onChange={e=>setCatalogSystem(e.target.value)}><option value="">Все системы</option>{[...new Set(allCatalog.map(e=>e.system ?? "-"))].map(id=><option key={id} value={id}>{systemName(id === "-" ? undefined : id)}</option>)}</select>
        <select aria-label="Категория макроса" value={catalogCategory} onChange={e=>setCatalogCategory(e.target.value)}><option value="">Все категории</option>{macroCategories.map(name=><option key={name}>{name}</option>)}</select>
        <select aria-label="Лицензия" value={catalogLicense} onChange={e=>setCatalogLicense(e.target.value)}><option value="">Все лицензии</option>{[...new Set(allCatalog.map(e=>e.license))].map(r=><option key={r}>{r}</option>)}</select>
        <select aria-label="Сортировка" value={catalogSort} onChange={e=>setCatalogSort(e.target.value)}><option value="name">По названию</option><option value="date">Сначала новые</option></select>
      </div>
      {catalogError && <p className="catalog-status" role="status">{catalogError}</p>}
      {!visibleCatalog.length && <p className="empty">Макросы не найдены.</p>}
      <div className="macro-grid">{visibleCatalog.map(entry=>{
        const category=entry.category ?? "Прочее";
        const Icon=macroIcons[category];
        return <article className="macro-card" key={JSON.stringify([entry.repo,entry.path,entry.commit])}>
          <div className="macro-category"><span className="macro-icon" data-category={category}><Icon size={19} aria-hidden="true"/></span>{category}{entry.inferredCategory ? " · предположительно" : ""}</div>
          <h2>{entry.translated?.title || entry.name}</h2>
          {entry.translated?.title && entry.translated.title!==entry.name && <small lang="en">{entry.name}</small>}
          <p>{entry.translated?.description || entry.description || (entry.enriched ? "Описание не указано." : "Описание загружается при открытии.")}</p>
          <small>{systemName(entry.system)}{entry.inferredSystem ? " · по пути файла" : ""}</small>
          <small className="macro-source">{entry.repo}</small>
          <div className="macro-actions"><button disabled={catalogBusy} onClick={()=>void inspectMacro(entry)}>Подробнее</button><button disabled={catalogBusy} onClick={()=>void inspectMacro(entry,true)}>В библиотеку</button></div>
        </article>;
      })}</div>
      <dialog className="catalog-dialog sources-dialog" ref={sourceDialog}>
        <div className="toolbar"><h2>Источники GitHub</h2><button onClick={()=>sourceDialog.current?.close()}>Закрыть</button></div>
        <div className="catalog-dialog-content">
          <label>Публичный репозиторий<input aria-label="Публичный репозиторий GitHub" value={repository} onChange={e=>setRepository(e.target.value)}/></label>
          <button disabled={catalogBusy} onClick={()=>void refreshCatalog()}>Обновить каталог</button>
          <ul key={catalogUpdated}>{catalogSources.map(repo=><li key={repo}><button onClick={()=>setRepository(repo)}>{repo}</button> <small>{sourceCheckedAt(repo) ? new Date(sourceCheckedAt(repo)!).toLocaleString("ru") : "Дата обновления неизвестна"}</small></li>)}</ul>
          <label className="file">Загрузить переводы JSON<input type="file" accept=".json" onChange={async e=>{
            const file=e.target.files?.[0];e.target.value="";if(!file)return;
            try {
              if(file.size>512_000)throw Error("Файл переводов больше 512 КБ.");
              const next={...translations,...z.record(z.string(),translationFields).parse(JSON.parse(await file.text()))};
              localStorage.setItem("catalog.translations.v1",JSON.stringify(next));setTranslations(next);
              setCatalogError("Переводы загружены.");
            } catch(error) {setCatalogError(report(error));}
          }}/></label>
          <p role="status">{catalogError}</p>
        </div>
      </dialog>
      <dialog className="catalog-dialog macro-dialog" ref={macroDialog}>
        {detail && <>
          <div className="toolbar"><h2>{detail.translated?.title || detail.name}</h2><button onClick={()=>macroDialog.current?.close()}>Закрыть</button></div>
          <div className="toolbar" role="group" aria-label="Разделы макроса"><button aria-pressed={catalogTab==="metadata"} onClick={()=>setCatalogTab("metadata")}>Описание</button><button aria-pressed={catalogTab==="code"} disabled={!detail.enriched} onClick={()=>setCatalogTab("code")}>Исходный код</button><button disabled={catalogBusy||!detail.enriched} onClick={()=>importMacro(detail)}>В библиотеку</button></div>
          {catalogTab==="code" ? <CodeView key={detail.commit+detail.path} code={detail.code ?? ""}/> : <div className="catalog-dialog-content">
            {catalogBusy && <p role="status">Загрузка метаданных…</p>}{catalogError && <p role="status">{catalogError}</p>}
            <dl className="script-card-details">
              <dt>Оригинал</dt><dd>{detail.name}</dd><dt>Автор</dt><dd>{detail.author || "Не указан"}</dd>
              <dt>Категория</dt><dd>{detail.category}{detail.inferredCategory ? " · предположительно" : ""}</dd>
              <dt>Система</dt><dd>{systemName(detail.system)}{detail.inferredSystem ? " · по пути файла" : ""}</dd>
              <dt>Foundry</dt><dd>{detail.compatibility}</dd><dt>Лицензия файла</dt><dd>{detail.license}</dd>
              {detail.repoLicense && <><dt>Лицензия репозитория</dt><dd>{detail.repoLicense}</dd></>}
              <dt>Источник</dt><dd><a href={catalogSourceUrl(detail)} target="_blank" rel="noreferrer">{detail.repo} / {detail.path}</a></dd>
              <dt>Версия исходника</dt><dd>{detail.commit}</dd>
              {detail.updatedAt && <><dt>{detail.original?.updated ? "Обновлён" : "Дата снимка"}</dt><dd>{new Date(detail.updatedAt).toLocaleDateString("ru")}</dd></>}
              {detail.original?.dependencies && <><dt>Заявленные зависимости</dt><dd>{detail.original.dependencies}</dd></>}
              {!!detail.dependencies?.length && <><dt>Возможные зависимости</dt><dd>{detail.dependencies.join(", ")}</dd></>}
            </dl>
            <p>{detail.translated?.description || detail.description || "Описание не указано."}</p>
            {(detail.translated?.instructions || detail.original?.instructions) && <><h3>Инструкции</h3><p>{detail.translated?.instructions || detail.original?.instructions}</p></>}
            {(detail.translated?.requirements || detail.original?.requirements) && <><h3>Требования к запуску</h3><p>{detail.translated?.requirements || detail.original?.requirements}</p></>}
            {detail.enriched && detail.original && <button onClick={()=>void navigator.clipboard.writeText(JSON.stringify({
              [translationKey(detail.repo,detail.path,detail.original!)]:{title:detail.original!.title,description:detail.original!.description,instructions:detail.original!.instructions,requirements:detail.original!.requirements,category:detail.original!.category},
            },null,2)).then(()=>setCatalogError("Шаблон перевода скопирован. Переведите значения и загрузите JSON в настройках источников.")).catch(error=>setCatalogError(report(error)))}>Копировать шаблон перевода</button>}
            {detail.licenseText && <details><summary>Лицензионный текст</summary><pre>{detail.licenseText}</pre></details>}
          </div>}
        </>}
      </dialog>
    </section> : <section className="workspace"><nav aria-label="Открытые скрипты">{tabs.map((tab) =>
      <div className="row" key={tab.id}><button aria-current={id === tab.id} onClick={() => open(tab)}>{tab.name}{dirty(tab) ? " •" : ""}</button>
        <button aria-label={`Закрыть ${tab.name}`} onClick={() => {
          if (dirty(tab) && !confirm("Закрыть вкладку с несохранёнными изменениями?")) return;
          const others = tabs.filter((item) => item.id !== tab.id);
          setTabs(others);
          if (tab.id === id) { setId(others[others.length - 1]?.id ?? ""); resetHistory(); }
        }}>×</button></div>)}</nav>
      {script && <>
        <div className="toolbar"><button onClick={() => void save(script)}>Сохранить</button><SendToFoundry key={script.id} script={script} unsaved={dirty(script)}/>
          <button onClick={() => {
            const target = prompt("ID игрового мира для копии. Пустое поле — общая библиотека.", script.world);
            if (target === null) return;
            const world = target.trim();
            const path = prompt("Путь папки для копии", world === script.world ? script.folder : "");
            if (path === null) return;
            try {
              open({...script, id: crypto.randomUUID(), name: script.name + " (копия)", world, folder: folderPath(path)});
            } catch (error) { setMessage(report(error)); }
          }}>Копировать</button>
          <button onClick={() => downloadScript(script)}>Экспорт .js</button>
          <button onClick={() => setExchange(!exchange)}>Обмен с ChatGPT</button>
          <label>Шрифт <select aria-label="Размер шрифта редактора" value={editorFont} onChange={event => {
            setEditorFont(Number(event.target.value));
            localStorage.setItem("fate-scripts.editor-font", event.target.value);
          }}>{Array.from({length: 19}, (_, i) => i + 10).map(size => <option key={size}>{size}</option>)}</select></label>
          <button onClick={() => {
            try {
              const matches = [...new Set([...detectDependencies(script.code), ...dependencyIds(script.dependencies ?? "")])];
              setMessage(matches.length ? "Предполагаемые модули: " + matches.join(", ") : "Признаки зависимостей не найдены.");
            } catch (error) { setMessage("Ошибка синтаксиса: " + report(error)); }
          }}>Проверить зависимости</button>
          <button onClick={() => void loadHistory(script.id)}>История</button>
        </div>
        <details><summary>Карточка скрипта</summary>
          <ScriptCardImage key={script.id} image={script.image} onError={setMessage} onChange={image => {
            setTabs(previous => previous.map(tab => {
              if (tab.id !== script.id) return tab;
              const next = {...tab};
              if (image) next.image = image;
              else delete next.image;
              return next;
            }));
          }}/>
          <p><small>UUID {script.id}</small></p>
          {details && <dl className="script-card-details">
            <dt>Создан</dt><dd>{new Date(details.created).toLocaleString("ru")}</dd>
            <dt>Изменён</dt><dd>{new Date(details.modified).toLocaleString("ru")}</dd>
            {details.macroId && <><dt>Макрос Foundry</dt><dd>{details.origin} · {details.worldId} · {details.macroId}</dd></>}
          </dl>}
          <div className="fields">{Object.entries(fields).map(([key, label]) => {
          const field = key as keyof typeof fields;
          return <label key={key}>{label}<input value={script[field]} onChange={(event) => edit({ ...script, [field]: event.target.value })} /></label>;
        })}<label>Версия Foundry<input value={script.foundryVersion ?? ""} onChange={e=>edit({...script,foundryVersion:e.target.value})}/></label><label>Дополнительные ID модулей<input value={script.dependencies ?? ""} onChange={e=>edit({...script,dependencies:e.target.value})}/></label></div>{script.provenance && <small>{script.provenance.author} · {script.provenance.license} · {catalogSourceUrl(script.provenance)}</small>}</details>
        {exchange && <section className="exchange">
          <input aria-label="Задача для ChatGPT" placeholder="Что должен сделать ChatGPT" value={requirements} onChange={(event) => setRequirements(event.target.value)} />
          <button disabled={!requirements.trim()} onClick={() => {
            try {
              const sample = formatScriptText({ name: script.name, description: script.description, foundryVersion: script.foundryVersion || "14" }, script.code);
              const manual = dependencyIds(script.dependencies ?? "");
              let inferred: string[] = [];
              try { inferred = detectDependencies(script.code); } catch { /* Preserve the original text for repair. */ }
              const [origin, worldId] = script.world.split("#");
              const modules = dependencyStatus([...manual, ...inferred], inventory, origin, worldId);
              const prompt = [
                "Подготовь JavaScript-макрос для Foundry VTT v14 по описанию ниже.",
                requirements,
                `Модули: ${modules.map(module => module.version ? `${module.id} ${module.version}` : module.id).join(", ") || "не указаны"}`,
                ...(diagnosticContext ? ["Диагностический контекст выполнения:", diagnosticContext] : []),
                "Верни ровно один блок FATE SCRIPT TEXT 1.0. Используй JSON-объект для метаданных и отдельный блок JavaScript между маркерами. Сохраняй значимые переводы строк и обратные слеши.",
                "Текущий скрипт и пример формата:",
                sample,
              ].join("\n\n");
              setOutgoing(redactSecrets(prompt));
            } catch (error) { setMessage(report(error)); }
          }}>Подготовить промпт</button>
          <button onClick={() => {
            try { setOutgoing(redactSecrets(formatScriptText({ name: script.name, description: script.description, foundryVersion: script.foundryVersion || "14", tags: script.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }, script.code))); }
            catch (error) { setMessage(report(error)); }
          }}>Подготовить текущий код</button>
          {diagnosticContext && <button onClick={() => {setDiagnosticContext(""); setOutgoing("");}}>Убрать отчёт из промпта</button>}
          <textarea aria-label="Предпросмотр промпта" value={outgoing} onChange={event => setOutgoing(event.target.value)} />
          <button disabled={!outgoing} onClick={() => void navigator.clipboard.writeText(redactSecrets(outgoing)).then(() => setMessage("Промпт скопирован")).catch((error) => setMessage(report(error)))}>Копировать промпт</button>
          <textarea aria-label="Ответ ChatGPT" placeholder="Вставьте ответ ChatGPT" value={input} onPaste={(event) => {
            event.preventDefault();
            setInput(event.clipboardData.getData("text/plain"));
          }} onChange={(event) => setInput(event.target.value)} />
          <label><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} /> Чистый JavaScript</label>
          <button onClick={preview}>Просмотреть изменения</button>
        </section>}
        {versions.length > 0 && <div className="toolbar">
          <select aria-label="Версия для сравнения" value={compare} onChange={(event) => setCompare(event.target.value)}><option value="">Текущий редактор</option>
            {versions.map((version) => <option key={version.number} value={version.number}>Версия {version.number}</option>)}</select>
          <select aria-label="Историческая версия" value="" onChange={(event) => {
            const version = versions.find((value) => String(value.number) === event.target.value);
            const base = versions.find((value) => String(value.number) === compare);
            if (version) setReview({
              before: base?.code ?? script.code,
              after: version.code,
              beforeLabel: base ? `Версия ${base.number}` : "Текущий редактор",
              afterLabel: `Версия ${version.number}`,
              actionLabel: `Восстановить версию ${version.number}`,
              accept: () => void save({ ...script, code: version.code }, "Восстановление", true),
            });
          }}><option value="">Открыть версию</option>{versions.map((version) => <option key={version.number} value={version.number}>№{version.number} · {version.source} · {new Date(version.date).toLocaleString("ru")}</option>)}</select>
        </div>}
        <CodeView key={`${script.id}:${editorRevision}`} code={script.code} fontSize={editorFont} onChange={(code) => edit({ ...script, code })} />
      </>}
      {!script && <p className="empty">Создайте скрипт или откройте запись из библиотеки.</p>}
    </section>}
    <div hidden={!deck} className="deck-runner-fixed"><FoundryRunner script={scripts.find(s=>s.id===deckScript)} inventory={inventory}/></div>
    {review && <div className="overlay"><section role="dialog" aria-modal="true" aria-label="Сравнение версий"><h2>Сравнение JavaScript</h2>
      <p>Слева: {review.beforeLabel} · Справа: {review.afterLabel}</p>
      <CodeView code={review.after} original={review.before} />
      <div className="toolbar"><button onClick={() => setReview(undefined)}>Закрыть</button><button onClick={review.accept}>{review.actionLabel}</button></div>
    </section></div>}
  </main>;
}

function DetachedDeck(){
 const [scripts,setScripts]=useState<Script[]>([]); const [selected,setSelected]=useState(""); const [error,setError]=useState(""); const [top,setTop]=useState(false);
 useEffect(()=>{let active=true; const refresh=()=>void invoke<Script[]>("list_scripts").then(rows=>{if(active)setScripts(rows)}).catch(e=>{if(active)setError(report(e))});refresh();window.addEventListener("focus",refresh);return()=>{active=false;window.removeEventListener("focus",refresh)}},[]);
 return <section className="detached-deck"><div className="toolbar"><label><input type="checkbox" checked={top} onChange={e=>{const value=e.target.checked;void invoke("deck_always_on_top",{enabled:value}).then(()=>setTop(value)).catch(e=>setError(report(e)))}}/>Поверх окон</label><button onClick={()=>void invoke<Script[]>("list_scripts").then(setScripts).catch(e=>setError(report(e)))}>Обновить библиотеку</button></div><p role="status">{error}</p><LiveBridge/><RunConsole/><Deck scripts={scripts} onSelect={setSelected}/><h2>{scripts.find(s=>s.id===selected)?.name??"Выберите скрипт"}</h2><FoundryRunner script={scripts.find(s=>s.id===selected)} inventory={null}/></section>
}
createRoot(document.getElementById("root")!).render(<StrictMode>{getCurrentWindow().label==="deck"?<DetachedDeck/>:<App/>}</StrictMode>);
