import { classifyMacro, documentMetadata, glossaryTitle, macroCandidate, macroFile, systemFromPath, type Category, type Metadata, type Translation } from "./catalog-metadata";
import { z } from "zod";
import bundledCode from "./catalog/show-xp.js?raw";
import licenseText from "./catalog/THEJOESTER-LICENSE.txt?raw";

export type CatalogEntry = {
  name: string; description: string; repo: string; path: string; commit: string;
  author: string; license: string; compatibility: string; code?: string; licenseText?: string;
  original?: Metadata; translated?: Translation; category?: Category; system?: string; inferredSystem?: boolean;
  dependencies?: string[]; inferredCategory?: boolean; updatedAt?: string; documentation?: string;
  enriched?: boolean; unsupported?: boolean; repoLicense?: string;
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

const repository = z.object({ default_branch: z.string(), license: z.object({ spdx_id: z.string() }).nullable() });
const revision = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), commit:z.object({committer:z.object({date:z.string()}).nullable()}).optional() });
const paths = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })) });
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
  const documents = new Map(listing.tree.filter(file => file.type === "blob" && /\.md$/i.test(file.path) &&
    (file.size ?? Infinity) <= 100_000).map(file => [file.path.toLowerCase(),file.path]));
  return {state:next,entries:listing.tree.filter(file => file.type === "blob" && macroCandidate(file.path) &&
    (file.size ?? Infinity) <= maxCodeBytes).map(file => {
    const name = file.path.split("/").pop()!;
    const parent = file.path.includes("/") ? file.path.slice(0,file.path.lastIndexOf("/")+1) : "";
    const documentation = [name.replace(/\.[^.]+$/,".md"),"readme.md","usage.md","documentation.md"].map(name => documents.get((parent+name).toLowerCase())).find(Boolean)
      ?? documents.get("readme.md");
    const original = {title:name};
    const system = systemFromPath(file.path);
    return {
      name, description:"", repo, path:file.path, commit:head.sha, author:"", license:"Не определена",
      repoLicense:info.license?.spdx_id === "NOASSERTION" ? undefined : info.license?.spdx_id,
      compatibility:"Не проверена", original, translated:{title:glossaryTitle(name)}, system, inferredSystem:Boolean(system),
      ...classifyMacro(original,file.path), updatedAt:head.commit?.committer?.date, documentation,
    };
  })};
}

const documents = new Map<string, Promise<string>>();
function readDocument(entry: CatalogEntry) {
  if (!entry.documentation) return Promise.resolve("");
  const path = entry.documentation;
  const key = JSON.stringify([entry.repo,entry.commit,path]);
  const existing = documents.get(key);
  if (existing) return existing;
  const result = readSource({...entry,path,code:undefined}).catch(() => {documents.delete(key); return "";});
  if (documents.size > 100) documents.clear();
  documents.set(key,result);
  return result;
}

export async function enrichCatalogEntry(entry: CatalogEntry): Promise<CatalogEntry> {
  if (entry.enriched) return entry;
  const [raw, document] = await Promise.all([readSource(entry),readDocument(entry)]);
  const {code, metadata} = macroFile(raw,entry.path);
  const filename = entry.path.split("/").pop()!;
  const sidecar = entry.documentation?.toLowerCase() === entry.path.replace(/\.[^.]+$/,".md").toLowerCase();
  const documented = documentMetadata(document,[filename,metadata.title ?? entry.name],sidecar);
  const original = {...documented,...Object.fromEntries(Object.entries(metadata).filter(([,v])=>v !== undefined))} as Metadata;
  const name = original.title || entry.name;
  const declaredDate = original.updated?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  const system = original.system || entry.system;
  return {...entry, code, enriched:true, original:{...original,title:name}, name,
    description:original.description ?? "", author:original.author ?? "", license:original.license ?? "Не определена",
    compatibility:original.versions ? `Заявлено автором: ${original.versions}. Совместимость с v14 не проверена.` : "Не проверена",
    system, inferredSystem:!original.system && Boolean(system), ...classifyMacro(original,entry.path,code),
    translated:{title:glossaryTitle(name)}, updatedAt:declaredDate ?? entry.updatedAt,
  };
}

async function readSource(entry: CatalogEntry) {
  if (entry.code !== undefined) return entry.code;
  const response = await checkedResponse(`https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${encodedPath(entry.path)}`);
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
      if (length > maxCodeBytes) throw new Error("Файл больше 1 МБ.");
      code += decoder.decode(value, { stream: true });
    }
    return code + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

export const catalogSourceUrl = revisionUrl;
