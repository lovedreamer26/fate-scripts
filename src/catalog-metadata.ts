import { parse } from "acorn";
import { detectDependencies } from "./dependencies.ts";

export const categories = ["Сражения", "Заклинания", "Персонажи", "Анимации", "Карты и сцены", "Токены", "Предметы", "Инструменты ГМ", "Системные", "Прочее"] as const;
export type Category = typeof categories[number];
export type Metadata = {
  title?: string; description?: string; author?: string; system?: string;
  versions?: string; license?: string; instructions?: string; requirements?: string; category?: string; updated?: string; dependencies?: string;
};
export type Translation = Pick<Metadata, "title" | "description" | "instructions" | "requirements" | "category">;

const labels: Record<string, keyof Metadata> = {
  "title":"title", "macro title":"title", "name":"title", description:"description",
  author:"author", system:"system", "game system":"system", "foundry version":"versions",
  "foundry versions":"versions", compatibility:"versions", license:"license", usage:"instructions",
  instructions:"instructions", requirements:"requirements", prerequisites:"requirements", requires:"requirements", dependencies:"dependencies", modules:"dependencies", category:"category", "last updated":"updated", updated:"updated",
};

export function parseMetadata(text: string): Metadata {
  const result: Metadata = {};
  let field: keyof Metadata | undefined;
  for (const raw of text.split(/\r?\n/).slice(0, 150)) {
    const line = raw.replace(/^\s*(?:\/\/|\/\*+|\*+)\s?/, "").trim();
    const label = /^@?([\w -]+?)(?:\s*:\s*|\s+-\s+)(.*)$/.exec(line)
      ?? /^@(description|author|name|title|license|system|usage|requirements|requires|dependencies)\s+(.*)$/i.exec(line);
    if (label) {
      field = labels[label[1].toLowerCase()];
      if (field && label[2]) result[field] = label[2].slice(0, 1500);
    } else if (field && line && !/^[-*/=]+$/.test(line) && ["description","instructions","requirements","dependencies"].includes(field)) {
      result[field] = [result[field], line].filter(Boolean).join("\n").slice(0, 1500);
    } else if (!line || /^[-*/=]+$/.test(line)) field = undefined;
  }
  return result;
}

export function documentMetadata(text: string, names: string[], isSidecar: boolean): Metadata {
  const normalize = (value: string) => value.trim().replace(/\.(?:[cm]?js|json)$/i,"").replace(/[-_]/g," ").toLowerCase();
  const keys = new Set(names.map(normalize));
  const lines = text.split(/\r?\n/);
  const headings = lines.map(line => /^(#{1,6})\s+(.+?)\s*$/.exec(line));
  const index = headings.findIndex(h => h && keys.has(normalize(h[2])));
  if (index < 0 && !isSidecar) return {};
  const level = headings[index]?.[1].length ?? 0;
  const end = headings.findIndex((h,i) => i > index && h && h[1].length <= level);
  const section = lines.slice(index+1,end < 0 ? undefined : end).slice(0,150);
  const result = parseMetadata(section.map(line => {
    const heading = /^#+\s+(.+?)\s*$/.exec(line)?.[1];
    return heading && labels[heading.toLowerCase()] ? heading + ":" : line;
  }).join("\n"));
  if (!result.description) {
    const paragraph = section.join("\n").trim().split(/\n\s*\n/)[0]?.trim();
    if (paragraph && !/^(#|```|[-*] |\|)/.test(paragraph)) result.description = paragraph.slice(0,1000);
  }
  return result;
}

const excluded = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures|examples|node_modules|vendor|dist|build|config|lib|libs|utils|helpers|\.github)(?:\/|$)|(?:^|\/)(?:package(?:-lock)?|module|system|world|manifest|index|setup|webpack|vite|rollup|eslint|tsconfig|babel|jest|vitest)(?:[.\-][^/]*)?\.(?:[cm]?js|json)$|\.(?:test|spec|min|config)\.[cm]?js$/i;
export function macroCandidate(path: string): boolean {
  return /\.(?:[cm]?js|json)$/i.test(path) && !excluded.test(path)
    && (!/\.json$/i.test(path) || /(?:^|\/)(?:macros?\/|[^/]+\.macro\.json$)/i.test(path));
}

export class UnsupportedMacroError extends Error {}

export function macroFile(text: string, path: string): { code: string; metadata: Metadata } {
  if (/\.json$/i.test(path)) {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("type" in value) || value.type !== "script" ||
      !("command" in value) || typeof value.command !== "string") throw new UnsupportedMacroError("JSON не содержит JavaScript-макрос Foundry.");
    const doc = value as Record<string, unknown>;
    return {code:value.command, metadata:{
      title: typeof doc.name === "string" ? doc.name : undefined,
      description: typeof doc.description === "string" ? doc.description : undefined,
    }};
  }
  const prefix = text.replace(/^\uFEFF/, "").trimStart();
  const header = /^(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\r\n]*(?:\r?\n|$)\s*)+/.exec(prefix)?.[0] ?? "";
  // Module exports and Node imports are not usable from a Foundry macro.
  try {
    const tree = parse(prefix, {ecmaVersion:"latest", sourceType:"module",allowReturnOutsideFunction:true});
    if (tree.body.some(node => node.type === "ImportDeclaration" || node.type.startsWith("Export") ||
      node.type === "ExpressionStatement" && /^(?:module\.exports|exports\.|require\s*\()/.test(prefix.slice(node.start,node.end)))) {
      throw new UnsupportedMacroError("Файл содержит модуль JavaScript, а не готовый макрос Foundry.");
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // The exact original code remains available for macro contexts the parser cannot validate.
  }
  return {code:text, metadata:parseMetadata(header)};
}

const categoryRules: [Category, RegExp][] = [
  ["Анимации", /animat|sequenc|tokenmagic|jb2a|анимац/i],
  ["Заклинания", /spell|cantrip|заклин/i],
  ["Сражения", /combat|initiative|attack|damage|сражен|инициатив/i],
  ["Карты и сцены", /scene|map|wall|сцен|карт/i],
  ["Токены", /token|токен/i],
  ["Предметы", /item|loot|предмет/i],
  ["Персонажи", /actor|character|party|\bxp\b|персонаж/i],
  ["Инструменты ГМ", /\bgm\b|gamemaster|мастер/i],
  ["Системные", /system|utility|settings|систем/i],
];

export function systemFromPath(path: string): string | undefined {
  const match = path.match(/(?:^|\/)(dnd5e|pf2e|pf1|sfrpg|swade|wfrp4e|coc7)(?:\/|$)/i);
  return match?.[1].toLowerCase();
}

export function classifyMacro(metadata: Metadata, path: string, code = "") {
  let dependencies: string[] = [];
  if (code) try { dependencies = detectDependencies(code); } catch { /* Analyzing text does not execute it. */ }
  const declared = categories.find(category => category === metadata.category);
  const subject = [metadata.category, metadata.title, metadata.description, path.replace(/[-_/]/g," "), ...dependencies].join(" ");
  const category = declared ?? categoryRules.find(([, pattern]) => pattern.test(subject))?.[0] ?? "Прочее";
  return {category, inferredCategory: !declared && category !== "Прочее", dependencies};
}

const glossary: [RegExp,string][] = [
  [/\bshow xp\b/gi,"Показать опыт"],[/\bcombat tracker\b/gi,"Трекер боя"],
  [/\binitiative\b/gi,"инициатива"],[/\bhit points\b/gi,"очки здоровья"],
  [/\bspell(?:s)?\b/gi,"заклинания"],[/\btoken(?:s)?\b/gi,"токены"],
  [/\bscene(?:s)?\b/gi,"сцены"],[/\bitem(?:s)?\b/gi,"предметы"],
  [/\bcharacter(?:s)?\b/gi,"персонажи"],[/\broll dice\b/gi,"бросить кости"],
];
export function glossaryTitle(title: string): string | undefined {
  let translated = title.replace(/\.(?:[cm]?js|json)$/i,"").replace(/[-_]/g," ");
  for (const [phrase, russian] of glossary) translated = translated.replace(phrase,russian);
  // Keep the original when only a fragment could be translated.
  return /[а-яё]/i.test(translated) && !/[a-z]/i.test(translated)
    ? translated.charAt(0).toUpperCase() + translated.slice(1) : undefined;
}
export function translationKey(repo: string, path: string, original: Metadata) {
  return JSON.stringify([repo,path,original.title,original.description,original.instructions,original.requirements,original.category]);
}
