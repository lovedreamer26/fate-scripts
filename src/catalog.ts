import { classifyMacro, documentMetadata, glossaryTitle, macroCandidate, macroFile, systemFromPath, UnsupportedMacroError, type Category, type Metadata, type Translation } from "./catalog-metadata";
import { z } from "zod";
import { analysisVersion, analyzeMacro, normalizeSystem, type MacroAnalysis } from "./catalog-analysis";
import bundledCode from "./catalog/show-xp.js?raw";
import licenseText from "./catalog/THEJOESTER-LICENSE.txt?raw";

export type CatalogEntry = {
  name: string; description: string; repo: string; path: string; commit: string;
  author: string; license: string; compatibility: string; code?: string; licenseText?: string;
  original?: Metadata; translated?: Translation; category?: Category; system?: string; inferredSystem?: boolean;
  dependencies?: string[]; inferredCategory?: boolean; updatedAt?: string; documentation?: string;
  enriched?: boolean; unsupported?: boolean; repoLicense?: string;
  analysis?: MacroAnalysis; analyzerVersion?: number; sourceHash?: string; blobSha?: string;
  documentationPaths?: string[]; documentationKey?: string; wiki?: boolean;
  sourceMetadata?: Metadata; documentedMetadata?: Metadata; descriptionSource?: string;
  rulesEdition?: "2014" | "2024";
};

export const bundled: CatalogEntry[] = [{
  name: "Show XP", description: "Показывает опыт участников группы в чате PF2e.",
  repo: "thejoester/foundryvtt-macros", path: "macros/pf2e/show-xp.js",
  commit: "3d86793e92a39a2a2e2ee6c150508c6f23da1774", author: "Joseph Thomas (TheJoester)",
  license: "MIT", compatibility: "PF2e, заявлены v12–v13. v14 не проверена.",
  code: bundledCode, licenseText, enriched: true, category: "Персонажи", system: "pf2e",
  original: {title:"Show XP", description:"Sends message to Chat showing all party actors and their current XP", versions:"v12–v13"},
  translated: {title:"Показать опыт", description:"Показывает опыт участников группы в чате PF2e."},
}];

const repository = z.object({ default_branch: z.string(), license: z.object({ spdx_id: z.string() }).nullable(), has_wiki:z.boolean().optional() });
const revision = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), commit:z.object({committer:z.object({date:z.string()}).nullable()}).optional() });
const paths = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional(), sha:z.string().optional() })) });
const maxCodeBytes = 1_000_000;
const revisionUrl = (entry: CatalogEntry) => `https://github.com/${entry.repo}/blob/${entry.commit}/${encodedPath(entry.path)}`;
const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export class GitHubRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("Достигнут лимит запросов GitHub.");
  }
}

export async function checkedResponse(url: string, etag?: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: etag ? {"If-None-Match":etag} : undefined });
  if (response.status === 304 && etag) return response;
  const retry = response.headers.get("retry-after");
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  if (response.status === 429 || response.status === 403 && (exhausted || retry !== null ||
    /rate limit|abuse detection/i.test(await response.clone().text()))) {
    const reset = exhausted ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : 0;
    const now = Date.now();
    const hint = retry === null ? 0 : /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
    const retryAt = Math.max(reset || 0, hint || 0);
    throw new GitHubRateLimitError(retryAt > now ? retryAt : now + 60_000);
  }
  if (!response.ok) throw new GitHubHttpError(response.status);
  return response;
}

export class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub вернул HTTP ${status}.`);
  }
}

export class IncompleteRepositoryError extends Error {}

type SourceState = {etag?:string; branch?:string; commit?:string; checkedAt?:string};
function state(repo: string): SourceState {
  try { return JSON.parse(localStorage.getItem("catalog.source."+repo) ?? "{}") ?? {}; }
  catch { return {}; }
}
export function sourceCheckedAt(repo: string) { return state(repo).checkedAt; }
export function markSourceChecked(repo: string, options: SourceState = {}) {
  localStorage.setItem("catalog.source."+repo, JSON.stringify({...state(repo),...options,checkedAt:new Date().toISOString()}));
}
export async function refreshRepository(repo: string, cached?: CatalogEntry[], signal?: AbortSignal): Promise<{entries: CatalogEntry[]; state: SourceState}> {
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repo) || /\/(?:\.|\.\.)$/.test(repo)) {
    throw new Error("Укажите публичный репозиторий в формате владелец/репозиторий.");
  }
  const api = `https://api.github.com/repos/${repo}`;
  const json = async (url: string) => (await checkedResponse(url, undefined, signal)).json();
  const info = repository.parse(await json(api));
  const previous = state(repo);
  const response = await checkedResponse(`${api}/commits/${encodeURIComponent(info.default_branch)}`,
    cached && previous.branch === info.default_branch ? previous.etag : undefined, signal);
  if (response.status === 304 && cached) return {entries:cached,state:previous};
  const head = revision.parse(await response.json());
  const next = {etag:response.headers.get("etag") ?? undefined, branch:info.default_branch, commit:head.sha};
  if (cached && previous.commit === head.sha) return {entries:cached,state:next};
  const listing = paths.parse(await json(`${api}/git/trees/${head.sha}?recursive=1`));
  if (listing.truncated) throw new IncompleteRepositoryError("GitHub вернул неполное дерево. Выберите репозиторий меньшего размера.");
  const docs = listing.tree.filter(file => file.type === "blob" && /\.md$/i.test(file.path) && (file.size ?? Infinity) <= 100_000);
  const documents = new Map(docs.map(file => [file.path.toLowerCase(),file]));
  const oldEntries = new Map(cached?.map(entry=>[entry.path,entry]));
  return {state:next,entries:listing.tree.filter(file => file.type === "blob" && macroCandidate(file.path) &&
    (file.size ?? Infinity) <= maxCodeBytes).map(file => {
    const name = file.path.split("/").pop()!;
    const parent = file.path.includes("/") ? file.path.slice(0,file.path.lastIndexOf("/")+1) : "";
    const stem = name.replace(/\.[^.]+$/,"").toLowerCase();
    const related = docs.filter(doc=>doc.path.split("/").pop()?.toLowerCase() === stem+".md");
    const candidates = [parent+stem+".md",parent+"readme.md",parent+"usage.md",parent+"documentation.md","readme.md",
      ...related.map(doc=>doc.path),...docs.filter(doc=>/^(docs?|wiki)\//i.test(doc.path) && /macro|usage|readme/i.test(doc.path)).slice(0,4).map(doc=>doc.path)];
    const files = [...new Set(candidates.map(path=>documents.get(path.toLowerCase())).filter(item=>item!==undefined))].slice(0,8);
    const documentationPaths = files.map(doc=>doc.path);
    const documentationKey = JSON.stringify([Boolean(info.has_wiki),...files.map(doc=>[doc.path,doc.sha ?? head.sha])]);
    const original = {title:name};
    const system = systemFromPath(file.path);
    const old = oldEntries.get(file.path);
    const unchanged = file.sha && old?.blobSha === file.sha ? old : undefined;
    const metadata = unchanged?.documentationKey === documentationKey ? unchanged : undefined;
    return {
      name, description:"", author:"", license:"Не определена",
      repoLicense:info.license?.spdx_id === "NOASSERTION" ? undefined : info.license?.spdx_id,
      compatibility:"Не проверена", original, translated:{title:glossaryTitle(name)}, system, inferredSystem:Boolean(system),
      ...classifyMacro(original,file.path), ...metadata,
      code:unchanged?.code, sourceHash:unchanged?.sourceHash, sourceMetadata:unchanged?.sourceMetadata,
      repo,path:file.path,commit:head.sha, updatedAt:head.commit?.committer?.date, documentationPaths, documentationKey,
      blobSha:file.sha,wiki:info.has_wiki,
    };
  })};
}

const documents = new Map<string, Promise<string>>();
function readDocument(url: string) {
  const key = url;
  const existing = documents.get(key);
  if (existing) return existing;
  const result = readText(url,100_000).catch(error => {
    if (error instanceof GitHubHttpError && error.status === 404) return "";
    documents.delete(key);
    throw error;
  });
  if (documents.size > 100) documents.clear();
  documents.set(key,result);
  return result;
}

export const needsAnalysis = (entry: CatalogEntry) => entry.analyzerVersion !== analysisVersion || !entry.sourceHash;
const informative = (value?: string) => Boolean(value && (value.match(/\p{L}+/gu)?.length ?? 0) >= 4 &&
  !/^(todo|tbd|no description|description not available|описание не указано)\b/i.test(value.trim()));

export async function enrichCatalogEntry(entry: CatalogEntry, force = false): Promise<CatalogEntry> {
  if (!force && !needsAnalysis(entry)) return entry;
  const raw = entry.code ?? await readText(`https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${encodedPath(entry.path)}`,maxCodeBytes);
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
  const sourceHash = entry.sourceHash ?? Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
  let code: string, metadata: Metadata, analysis: MacroAnalysis;
  try {
    ({code,metadata} = entry.code !== undefined && /\.json$/i.test(entry.path)
      ? {code:raw,metadata:entry.sourceMetadata ?? entry.original ?? {}}
      : macroFile(raw,entry.path));
    analysis = analyzeMacro(code);
  } catch (error) {
    if (!(error instanceof UnsupportedMacroError) && !(error instanceof SyntaxError && /\.json$/i.test(entry.path))) throw error;
    return {...entry, code:undefined, enriched:false, unsupported:true, sourceHash, analyzerVersion:analysisVersion};
  }
  const filename = entry.path.split("/").pop()!;
  let documented = entry.documentedMetadata;
  let descriptionSource = entry.descriptionSource;
  if (!documented) {
    documented = {};
    if (!informative(metadata.description)) {
      const files = entry.documentationPaths ?? [entry.documentation ?? "README.md"];
      const wiki = `https://raw.githubusercontent.com/wiki/${entry.repo}/`;
      const urls = files.map(path=>[path,`https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${encodedPath(path)}`]);
      if (entry.wiki) urls.push(["Wiki: Home",wiki+"Home.md"]);
      for (const [path,url] of urls) {
        const document = await readDocument(url);
        if (path === "Wiki: Home" && document) urls.push(["Wiki: "+filename,
          wiki+encodeURIComponent(filename.replace(/\.[^.]+$/,"").replace(/[ _]/g,"-"))+".md"]);
        const sidecar = path.startsWith("Wiki: ") && path !== "Wiki: Home" ||
          path.split("/").pop()?.toLowerCase() === filename.replace(/\.[^.]+$/,".md").toLowerCase();
        const found = documentMetadata(document,[filename,metadata.title ?? entry.name],sidecar);
        if (/^readme\.md$/i.test(path) && !/\b(?:pathfinder|pf2e|pf1|swade|sfrpg|coc7|wfrp4e)\b/i.test(document) &&
          /macros?\s+(?:written\s+)?for\s+(?:5e\s+d\s*&\s*d|d\s*&\s*d\s*5e|dnd5e)\b/i.test(document.slice(0,2000))) found.system ??= "dnd5e";
        documented = {...found,...documented};
        if (informative(found.description)) {
          documented.description = found.description;
          descriptionSource = path;
          break;
        }
      }
    }
  }
  const original = {...documented,...Object.fromEntries(Object.entries(metadata).filter(([,v])=>v !== undefined))} as Metadata;
  if (informative(metadata.description)) descriptionSource = "Комментарии или поля исходника";
  else if (informative(documented.description)) original.description = documented.description;
  const description = informative(original.description) ? original.description! : analysis.description;
  const name = original.title || entry.name;
  const declaredDate = original.updated?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  const declaredSystem = normalizeSystem(original.system);
  const evidence = new Set([declaredSystem,systemFromPath(entry.path),analysis.system].filter(Boolean));
  const system = evidence.size === 1 ? [...evidence][0] : undefined;
  const edition = original.system?.match(/\b(2014|2024)\b/)?.[1] ?? entry.path.match(/(?:^|\/)(2014|2024)(?:\/|$)/)?.[1];
  return {...entry, code, enriched:true, original:{...original,title:name}, name,
    description, author:original.author ?? "", license:original.license ?? "Не определена",
    compatibility:original.versions ? `Заявлено автором: ${original.versions}. Совместимость с v14 не проверена.` : "Не проверена",
    system, inferredSystem:!declaredSystem && Boolean(system), ...classifyMacro(original,entry.path,code),
    translated:{title:glossaryTitle(name)}, updatedAt:declaredDate ?? entry.updatedAt,
    analysis, analyzerVersion:analysisVersion, sourceHash, sourceMetadata:metadata, documentedMetadata:documented,
    descriptionSource:informative(original.description) ? descriptionSource : undefined, unsupported:false,
    rulesEdition:system === "dnd5e" && (edition === "2014" || edition === "2024") ? edition : undefined,
  };
}

async function readText(url: string, limit: number) {
  const response = await checkedResponse(url);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub вернул пустой ответ.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let length = 0;
  let code = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("Размер файла превышает лимит каталога.");
      code += decoder.decode(value, { stream: true });
    }
    return code + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

export const catalogSourceUrl = revisionUrl;
