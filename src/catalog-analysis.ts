import { parse, type Node } from "acorn";
import { simple } from "acorn-walk";
import { UnsupportedMacroError } from "./catalog-metadata.ts";

export const analysisVersion = 1;
export type MacroAnalysis = {
  description: string;
  changes: string[];
  requirements: string[];
  instructions?: string;
  partial: boolean;
  system?: string;
};

export const defaultCatalogSystem = "dnd5e";
export const catalogSystems = ["dnd5e", "", "universal", "pf2e", "pf1", "-"];

export function normalizeSystem(value?: string) {
  const name = value?.trim();
  if (!name || /^(unknown|unspecified|неизвестно|не указана)$/i.test(name)) return undefined;
  if (/^(?:universal|system[- ]agnostic|any system|all systems|универсальн\p{L}*|все системы)$/iu.test(name)) return "universal";
  if (/^(?:dnd5e|dnd\s*5e|d\s*&\s*d\s*5e|dungeons\s*(?:&|and)\s*dragons\s*5e)(?:\s*[:(–-]?\s*(?:2014|2024)\)?)?$/i.test(name)) return "dnd5e";
  if (/^(?:pf2e|pathfinder\s*(?:2e?|second edition))$/i.test(name)) return "pf2e";
  if (/^(?:pf1e?|pathfinder\s*(?:1e?|first edition))$/i.test(name)) return "pf1";
  return name.toLowerCase();
}

export function analyzeMacro(code: string): MacroAnalysis {
  const actions = new Set<string>();
  const changes = new Set<string>();
  const requirements = new Set<string>();
  const systems = new Set<string>();
  const source = code.replace(/^\uFEFF/, "");
  let tree;
  try { tree = parse(source, {ecmaVersion:"latest", sourceType:"script",allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true}); }
  catch { return {description:"Назначение определено частично. Не удалось разобрать исходный код.",changes:[],requirements:[],partial:true}; }

  const text = (node: Node) => source.slice(node.start,node.end);
  const documents = new Set(["Actor","Token","Item","Scene","ActiveEffect","Combat","ChatMessage","JournalEntry","Wall","Tile","Macro","Playlist","MeasuredTemplate","RollTable"]);
  const documentNames: Record<string,string> = {
    Actor:"персонажи", Token:"токены", Item:"предметы", Scene:"сцены", ActiveEffect:"активные эффекты",
    Combat:"сражения", ChatMessage:"сообщения чата", JournalEntry:"записи журнала", Wall:"стены", Tile:"тайлы", Macro:"макросы",
  };
  const systemRoots = /^(?:game|CONFIG)\.(dnd5e|pf2e|pf1|sfrpg|swade|wfrp4e|coc7)\b/i;
  simple(tree,{
    MemberExpression(node) {
      const member = text(node);
      const system = systemRoots.exec(member)?.[1];
      if (system) systems.add(system.toLowerCase());
      if (/^(canvas\.tokens\.controlled|game\.user\.targets)(?:\.|$)/.test(member)) {
        requirements.add(member.startsWith("canvas") ? "Использует выделенные токены." : "Использует цели текущего пользователя.");
      }
      if (/^game\.user\.character(?:\.|$)/.test(member)) requirements.add("Обращается к персонажу текущего пользователя.");
      if (/^args\s*\[\s*0\s*\]$/.test(member)) requirements.add("Обращается к первому аргументу запуска (args[0]).");
    },
    BinaryExpression(node) {
      const other = text(node.left) === "game.system.id" ? node.right : text(node.right) === "game.system.id" ? node.left : undefined;
      if (other?.type === "Literal" && typeof other.value === "string" && /^(dnd5e|pf2e|pf1|sfrpg|swade|wfrp4e|coc7)$/.test(other.value) &&
        ["===","=="].includes(node.operator)) systems.add(other.value);
    },
    NewExpression(node) {
      const constructor = text(node.callee);
      if (constructor === "Roll") actions.add("Формирует бросок кубиков.");
      if (constructor === "MidiQOL.DamageOnlyWorkflow") {
        const kind = node.arguments[3];
        if (kind?.type === "Literal" && kind.value === "healing") {
          actions.add("Передаёт результат в Midi-QOL для лечения.");
          changes.add("Очки здоровья целей могут измениться.");
        } else actions.add("Запускает обработку урона через Midi-QOL.");
      }
    },
    CallExpression(node) {
      const callee = text(node.callee).replace(/\?\./g,".");
      const method = /(?:^|\.)(\w+)$/.exec(callee)?.[1];
      if (!method) return;
      const args = node.arguments.map(text);
      const receiver = callee.slice(0,-method.length-1);
      if (/^(rollAttack|rollDamage|rollAbilityTest|rollAbilitySave|rollSkill|rollInitiative)$/.test(method)) actions.add("Вызывает игровой бросок.");
      if (method === "applyDamage") { actions.add("Вызывает применение урона или лечения."); changes.add("Очки здоровья могут измениться."); }
      if (method === "heal" && /(?:^|\.)(?:actor|token)\b/i.test(receiver)) { actions.add("Вызывает лечение."); changes.add("Очки здоровья могут измениться."); }
      if (callee === "ChatMessage.create" || /^(?:new Roll\(|.*\.roll\().*\.toMessage$/.test(callee)) actions.add("Отправляет сообщение в чат.");
      if (callee.startsWith("ui.notifications.")) actions.add("Показывает уведомление Foundry.");
      if (/^(canvas\.scene|game\.scenes)(?:\.|$)/.test(receiver) && /^(view|activate)$/.test(method)) actions.add("Переключает сцену.");
      if (/^(create|update|delete)EmbeddedDocuments$/.test(method)) {
        const type = args[0]?.match(/^['"]([A-Za-z]+)['"]$/)?.[1];
        if (type && documents.has(type)) {
          const operation = method.startsWith("create") ? "создаёт" : method.startsWith("update") ? "изменяет" : "удаляет";
          changes.add(`Возможная операция: ${operation} ${documentNames[type] ?? "документы " + type}.`);
        }
      } else if (/^(create|update|delete)(Documents)?$/.test(method) && (documents.has(receiver) ||
        /(?:^|\.)(actor|token|item|scene|effect|document)(?:\.|$)/i.test(receiver))) {
        const operation = method.startsWith("create") ? "создавать" : method.startsWith("update") ? "обновлять" : "удалять";
        changes.add(`Может ${operation} игровые документы.`);
        if (/system\.attributes\.hp\b|\bhp\s*:/.test(args.join(" "))) changes.add("В записи затрагиваются очки здоровья.");
        if (/system\.abilities\b/.test(args.join(" "))) changes.add("В записи затрагиваются характеристики персонажа.");
        if (/(?:system|data)\.resources\./.test(args.join(" "))) changes.add("Может изменить ресурс персонажа.");
      }
      if (/\.(use|roll)$/.test(callee) && /(?:^|\.)(item|spell|ability)\b/i.test(receiver)) actions.add("Вызывает использование предмета, заклинания или способности.");
    },
  });
  if (!tree.body.some(node => !["FunctionDeclaration","ClassDeclaration","EmptyStatement"].includes(node.type) &&
    !(node.type === "VariableDeclaration" && node.declarations.every(declaration =>
      !declaration.init || ["FunctionExpression","ArrowFunctionExpression","ClassExpression","Literal","ObjectExpression","ArrayExpression"].includes(declaration.init.type))) &&
    !(node.type === "ExpressionStatement" && node.expression.type === "Literal"))) {
    throw new UnsupportedMacroError("Файл только объявляет данные или функции и не запускает макрос.");
  }
  const summary = [...actions,...changes].slice(0,4);
  const needsTokens = requirements.has("Использует выделенные токены.");
  return {description:summary.join(" ") || "Назначение определено частично. В коде не обнаружено однозначных игровых действий.",
    changes:[...changes],requirements:[...requirements],partial:!summary.length,
    instructions:needsTokens ? "Для действий с выделенными токенами выберите токены на сцене перед запуском." : undefined,
    system:systems.size === 1 ? [...systems][0] : undefined};
}
