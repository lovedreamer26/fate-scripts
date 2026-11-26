const prefix = "fate-scripts-bridge";
let generation = 0;

Hooks.once("init", () => game.settings.register(prefix, "worldIdentity", {
  scope: "world", config: false, type: String, default: "",
}));

function context() {
  if (!game.ready || !game.user?.isGM) throw Error("Требуется активная сессия GM.");
  return {
    origin: location.origin,
    worldId: game.world.id,
    userId: game.user.id,
    serverId: game.settings.get(prefix, "worldIdentity"),
  };
}

async function pairingContext() {
  const initial = context();
  if (!initial.serverId) {
    await game.settings.set(prefix, "worldIdentity", crypto.randomUUID());
  }
  const identity = context();
  if (identity.worldId !== initial.worldId || identity.userId !== initial.userId || !identity.serverId) {
    throw Error("Игровой мир или пользователь изменился во время сопряжения.");
  }
  return identity;
}

function storageKey({ worldId, userId }) {
  return JSON.stringify([prefix, "world-v1", worldId, userId]);
}

async function send(pairing, identity, message) {
  const match = /^([0-9]{1,5}):([a-f0-9]{64})$/.exec(pairing.trim());
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw Error("Некорректный код сопряжения.");
  return fetch(`http://127.0.0.1:${Number(match[1])}/fate-scripts/session/v1`, {
    method:"POST", credentials:"omit", redirect:"error", cache:"no-store",
    signal:AbortSignal.timeout(5000),
    headers:{Authorization:`Bearer ${match[2]}`,"Content-Type":"application/json"},
    body:JSON.stringify({...identity,...message}),
  });
}

function sameContext(expected) {
  try {
    const current = context();
    return Object.keys(expected).every(key => current[key] === expected[key]);
  } catch { return false; }
}

async function poll(pairing, identity, execute, instance) {
  const key = storageKey(identity);
  while (instance === generation && sameContext(identity)) {
    let response;
    try { response = await send(pairing, identity, {action:"poll"}); }
    catch { /* retry only the connection */ }
    if (response?.status === 403) {
      sessionStorage.removeItem(key);
      return;
    }
    if (response?.status === 200) {
      try {
        const job = await response.json();
        if (instance !== generation || !sameContext(identity)) return;
        if (job.origin !== identity.origin || job.worldId !== identity.worldId || job.serverId !== identity.serverId) return;
        const heartbeat = setInterval(() => {
          if (instance !== generation || !sameContext(identity)) return;
          void send(pairing, identity, {action:"heartbeat"}).catch(() => {});
        }, 3000);
        let result;
        try { result = await execute(job, async () => {
          if (instance !== generation || !sameContext(identity)) throw Error("Сопряжение отозвано.");
          const permit = await send(pairing, identity, {action:"authorize_write",runId:job.runId});
          if (permit.status !== 204 || instance !== generation || !sameContext(identity)) {
            throw Error("Запись больше не разрешена.");
          }
        }); }
        catch (error) { result = {status:"error",error:String(error?.message ?? error).slice(0,4000)}; }
        finally { clearInterval(heartbeat); }
        if (instance !== generation || !sameContext(identity)) return;
        const report = await send(pairing, identity, {action:"report",result:{...result,runId:job.runId,worldId:job.worldId}});
        if (!report.ok) throw Error("Отчёт не принят");
      } catch {
        ui.notifications.warn("Fate Scripts: отчёт не подтверждён. Операция автоматически не повторится.");
      }
    }
    await new Promise(resolve => setTimeout(resolve, response ? 1000 : 2500));
  }
}

export function registerLiveSession(execute) {
  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;
    const identity = context();
    const pairing = sessionStorage.getItem(storageKey(identity));
    if (pairing) void poll(pairing, identity, execute, ++generation);
  });
  return {
    connect() {
      if (!game.ready || !game.user?.isGM) return;
      void foundry.applications.api.DialogV2.prompt({
        window:{title:"Fate Scripts — сопряжение"},
        content:'<p>Разрешить Fate Scripts запуск сохранённых скриптов в текущем мире от имени GM на срок до 8 часов? Создание и обновление макросов потребуют отдельного подтверждения.</p><input type="password" name="pairing" required autocomplete="off" aria-label="Код постоянного сопряжения">',
        ok:{label:"Разрешить запуск",callback:async(event,button)=>{
          event.preventDefault();
          try {
            const pairing = String(new FormData(button.form).get("pairing")).trim();
            if (!/^[0-9]{1,5}:[a-f0-9]{64}$/.test(pairing)) throw Error("Некорректный код сопряжения.");
            const identity = await pairingContext();
            const legacyProfileId = localStorage.getItem(prefix + ".profile");
            const response = await send(pairing, identity, {action:"pair", identityKind:"world-v1", legacyProfileId});
            if (!response.ok) {
              const { reason } = await response.json().catch(() => ({}));
              if (reason === "bridgeVersion") throw Error("Версии Fate Scripts и Bridge несовместимы.");
              if (reason === "worldMismatch") throw Error("Открытый мир отличается от мира, выбранного в Fate Scripts.");
              if (reason === "profileMismatch") throw Error("Этот адрес закреплён за другим идентичностью мира Foundry.");
              throw Error(`Сопряжение отклонено (${response.status}). Проверьте код и срок его действия.`);
            }
            const { token } = await response.json();
            if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw Error("Bridge не вернул токен сессии.");
            const credentials = pairing.split(":")[0] + ":" + token;
            sessionStorage.setItem(storageKey(identity), credentials);
            void poll(credentials, identity, execute, ++generation);
            ui.notifications.info("Fate Scripts: сессия GM подключена.");
          } catch (error) { ui.notifications.error(String(error.message)); }
        }},rejectClose:false,
      }).catch(() => ui.notifications.error("Не удалось открыть диалог сопряжения."));
    },
    async disconnect() {
      if (!game.ready || !game.user?.isGM) return;
      ++generation;
      const identity = context();
      const key = storageKey(identity);
      const pairing = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      try {
        if (pairing) {
          const response = await send(pairing, identity, {action:"revoke"});
          if (!response.ok && response.status !== 403) throw Error();
        }
        ui.notifications.info("Fate Scripts: сессия отключена.");
      } catch { ui.notifications.warn("Fate Scripts: канал недоступен. Отзовите сопряжение в настольном приложении."); }
    },
  };
}
