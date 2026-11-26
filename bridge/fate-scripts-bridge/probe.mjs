import { readInventory } from "./inventory.mjs";
const id = "fate-scripts-bridge";

async function submitProbe(event, button) {
  event.preventDefault();
  const input = new FormData(button.form).get("pairing");
  if (!game.ready || !game.user?.isGM) throw new Error("Требуется активная сессия GM.");
  const match = /^([0-9]{1,5}):([a-f0-9]{64})$/.exec(String(input).trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error("Некорректный диагностический код.");
  }
  const response = await fetch(`http://127.0.0.1:${Number(match[1])}/fate-scripts/probe/v1`, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${match[2]}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: 1,
      version: game.version,
      macroCount: game.macros.size,
      moduleCount: game.modules.size,
    }),
  });
  if (response.status !== 204) throw new Error(`Диагностика отклонена (HTTP ${response.status}).`);
  ui.notifications.info("Fate Scripts Bridge: диагностический обмен подтверждён.");
}

function openProbe() {
  if (!game.ready || !game.user?.isGM) return false;
  void foundry.applications.api.DialogV2.prompt({
        window: { title: "Fate Scripts Bridge" },
        content: '<p>Передать версию Foundry и количество макросов и модулей в локальный диагностический сервер.</p><input type="password" name="pairing" autocomplete="off" required aria-label="Диагностический код">',
        ok: { label: "Подтвердить", callback: async (event, button) => {
          try {
            await submitProbe(event, button);
          } catch (error) {
            const message = error instanceof TypeError ? "Локальный канал недоступен." : String(error.message);
            ui.notifications.error(message);
          }
        } },
        rejectClose: false,
  }).catch(() => ui.notifications.error("Не удалось открыть окно диагностики."));
  return true;
}

Hooks.once("init", () => {
  game.keybindings.register(id, "probe", {
    name: "Fate Scripts Bridge: диагностика",
    restricted: true,
    editable: [{ key: "F9", modifiers: ["Control", "Shift"] }],
    onDown: openProbe,
  });
});

function addProbeButton(root) {
  if (!game.user?.isGM || !(root instanceof HTMLElement)) return;
  const settings = root.querySelector("section.settings");
  if (!settings || settings.querySelector("[data-fate-scripts-probe]")) return;
  for (const [label, open] of [
    ["Fate Scripts Bridge", openProbe],
    ["Fate Scripts — экспорт списка", openInventory],
    ["Fate Scripts — прямой запуск", openDirectRun],
    ["Fate Scripts — прямая запись", openDirectWrite],
    ["Fate Scripts — сопряжение GM", () => live.connect()],
    ["Fate Scripts — отключить сессию", () => live.disconnect()],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.fateScriptsProbe = "";
    button.textContent = label;
    button.addEventListener("click", open);
    settings.append(button);
  }
}

Hooks.on("renderSettings", (_app, html) => addProbeButton(html));
Hooks.once("ready", () => addProbeButton(document.getElementById("settings")));

function openInventory() {
  if (!game.ready || !game.user?.isGM) return false;
  void foundry.applications.api.DialogV2.prompt({
    window: {title: "Fate Scripts: экспорт списка макросов"},
    content: '<p>Передать исходный код всех макросов текущего мира локальному получателю? Игровые данные не изменяются.</p><input type="password" name="pairing" autocomplete="off" required aria-label="Код сопряжения">',
    ok: {label: "Передать", callback: async (event, button) => {
      event.preventDefault();
      try {
        const match = /^([0-9]{1,5}):([a-f0-9]{64})$/.exec(String(new FormData(button.form).get("pairing")).trim());
        if (!match || +match[1]<1 || +match[1]>65535) throw new Error("Некорректный код.");
        const data=readInventory(game,location.origin);
        const response=await fetch(`http://127.0.0.1:${+match[1]}/fate-scripts/inventory/v2`, {
          method:"POST", redirect:"error", credentials:"omit", signal:AbortSignal.timeout(10000),
          headers:{Authorization:`Bearer ${match[2]}`,"Content-Type":"application/json"},body:JSON.stringify(data)
        });
        if(response.status!==204) throw new Error(`Экспорт отклонён (HTTP ${response.status}).`);
        ui.notifications.info("Fate Scripts: список передан.");
      } catch(error) { ui.notifications.error(error instanceof TypeError ? "Локальный канал недоступен." : String(error.message)); }
    }}, rejectClose:false
  }).catch(()=>ui.notifications.error("Не удалось открыть окно экспорта."));
  return true;
}
Hooks.once("init",()=>game.keybindings.register(id,"inventory",{
  name:"Fate Scripts Bridge: экспорт списка",restricted:true,editable:[{key:"F10",modifiers:["Control","Shift"]}],onDown:openInventory
}));

import { applyWrite } from './write.mjs';
function openWrite() {
  if (!game.ready || !game.user?.isGM) return false;
  void foundry.applications.api.DialogV2.prompt({window:{title:'Fate Scripts: запись макроса'},content:'<p>Вставьте пакет записи из Fate Scripts.</p><textarea name="payload" required></textarea>',ok:{label:'Проверить',callback:async(event,button)=>{
    event.preventDefault();
    try {
      const p=JSON.parse(String(new FormData(button.form).get('payload')));
      const result=await applyWrite(p,game,location.origin,data=>Macro.create(data),async review=>{
        const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        return await foundry.applications.api.DialogV2.confirm({window:{title:'Подтвердить запись'},content:`<p>${escape(review.action)}: ${escape(review.name)}</p><h3>До</h3><pre>${escape(review.before)}</pre><h3>После</h3><pre>${escape(review.after)}</pre>`,rejectClose:false});
      });
      if(result.status==='written') ui.notifications.info(`Макрос записан: ${result.id}`);
    } catch(e){ui.notifications.error(String(e.message));}
  }},rejectClose:false}).catch(()=>ui.notifications.error('Окно записи закрыто'));
  return true;
}
Hooks.once('init',()=>game.keybindings.register(id,'write',{name:'Fate Scripts: запись макроса',restricted:true,editable:[{key:'F11',modifiers:['Control','Shift']}],onDown:openWrite}));

import { makeRunner } from './run.mjs';
let runner;
function openRun() {
  if (!game.ready || !game.user?.isGM) return false;
  runner ??= makeRunner({game,origin:location.origin,temporary:data=>new Macro(data),approve:()=>foundry.applications.api.DialogV2.confirm({window:{title:'Выполнение JavaScript'},content:'<p>Макрос может изменить реальные игровые данные даже в режиме теста. Выполнить?</p>',rejectClose:false})});
  void foundry.applications.api.DialogV2.prompt({window:{title:'Fate Scripts: запуск'},content:'<textarea name="payload" required aria-label="Пакет запуска"></textarea>',ok:{label:'Проверить',callback:async(event,button)=>{
    event.preventDefault();
    try {
      const result=await runner(JSON.parse(String(new FormData(button.form).get('payload'))));
      const field=document.createElement('textarea'); field.readOnly=true; field.value=JSON.stringify(result,null,2);
      const holder=document.createElement('div'); holder.append(field);
      await foundry.applications.api.DialogV2.prompt({window:{title:'Результат вызова — скопируйте в Fate Scripts'},content:holder,ok:{label:'Закрыть'},rejectClose:false});
    } catch(e){ui.notifications.error(String(e.message));}
  }},rejectClose:false}).catch(()=>ui.notifications.error('Окно запуска закрыто'));
  return true;
}
Hooks.once('init',()=>game.keybindings.register(id,'run',{name:'Fate Scripts Bridge: запуск',restricted:true,editable:[{key:'F12',modifiers:['Control','Shift']}],onDown:openRun}));

import { directRun } from './direct-run.mjs';
function openDirectRun(){
  if(!game.ready || !game.user?.isGM) return false;
  runner ??= makeRunner({game,origin:location.origin,temporary:data=>new Macro(data),approve:()=>foundry.applications.api.DialogV2.confirm({window:{title:'Выполнение JavaScript'},content:'<p>Макрос может изменить игровые данные. Выполнить?</p>',rejectClose:false})});
  void foundry.applications.api.DialogV2.prompt({window:{title:'Fate Scripts: прямой запуск'},content:'<input type="password" name="pairing" required aria-label="Код сопряжения">',ok:{label:'Получить запрос',callback:async(event,button)=>{event.preventDefault();try{await directRun({pairing:String(new FormData(button.form).get('pairing')),origin:location.origin,worldId:game.world.id,run:runner});ui.notifications.info('Отчёт передан');}catch(e){ui.notifications.error(String(e.message));}}},rejectClose:false}).catch(()=>ui.notifications.error('Окно закрыто'));
  return true;
}
Hooks.once('init',()=>game.keybindings.register(id,'directRun',{name:'Fate Scripts: прямой запуск',restricted:true,editable:[{key:'F8',modifiers:['Control','Shift']}],onDown:openDirectRun}));

function openDirectWrite(){
  if(!game.ready || !game.user?.isGM) return false;
  void foundry.applications.api.DialogV2.prompt({window:{title:'Fate Scripts: прямая запись'},content:'<input type="password" name="pairing" required aria-label="Код сопряжения">',ok:{label:'Получить запрос',callback:async(event,button)=>{event.preventDefault();try{
    await directRun({protocol:3,pairing:String(new FormData(button.form).get('pairing')),origin:location.origin,worldId:game.world.id,run:async p=>{
      const result=await applyWrite(p,game,location.origin,data=>Macro.create(data),async review=>{
        const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        return await foundry.applications.api.DialogV2.confirm({window:{title:'Подтвердить запись'},content:`<p>${escape(review.name)}</p><h3>До</h3><pre>${escape(review.before)}</pre><h3>После</h3><pre>${escape(review.after)}</pre>`,rejectClose:false});
      }); return {...result,runId:p.runId,worldId:p.worldId};
    }});ui.notifications.info('Отчёт записи передан');
  }catch(e){ui.notifications.error(String(e.message));}}},rejectClose:false}).catch(()=>ui.notifications.error('Окно закрыто'));
  return true;
}
Hooks.once('init',()=>game.keybindings.register(id,'directWrite',{name:'Fate Scripts: прямая запись',restricted:true,editable:[{key:'F7',modifiers:['Control','Shift']}],onDown:openDirectWrite}));

import { registerLiveSession } from './live-session.mjs';
let pairedRunner;
const live = registerLiveSession(async (request, authorizeWrite) => {
  if (request.protocol === 4) {
    pairedRunner ??= makeRunner({game,origin:location.origin,temporary:data=>new Macro(data),approve:async()=>true});
    return pairedRunner(request);
  }
  if (request.protocol !== 3) throw Error("Неизвестная операция");
  return applyWrite(request,game,location.origin,data=>Macro.create(data),async review=>{
    const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const approved = await foundry.applications.api.DialogV2.confirm({
      window:{title:'Подтвердить запись'},
      content:`<p>${escape(review.name)}</p><h3>До</h3><pre>${escape(review.before)}</pre><h3>После</h3><pre>${escape(review.after)}</pre>`,
      rejectClose:false,
    });
    if (approved) await authorizeWrite();
    return approved;
  });
});
