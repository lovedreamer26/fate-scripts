import { z } from "zod";
import bundledCode from "./catalog/show-xp.js?raw";
import licenseText from "./catalog/THEJOESTER-LICENSE.txt?raw";

export type CatalogEntry = {
  name: string; description: string; repo: string; path: string; commit: string;
  author: string; license: string; compatibility: string; code?: string; licenseText?: string;
};

export const bundled: CatalogEntry[] = [{
  name: "Show XP", description: "Показывает опыт участников группы в чате PF2e.",
  repo: "thejoester/foundryvtt-macros", path: "macros/pf2e/show-xp.js",
  commit: "3d86793e92a39a2a2e2ee6c150508c6f23da1774", author: "Joseph Thomas (TheJoester)",
  license: "MIT", compatibility: "PF2e, заявлены v12–v13. v14 не проверена.",
  code: bundledCode, licenseText,
}];

const repository = z.object({ default_branch: z.string(), license: z.object({ spdx_id: z.string() }).nullable() });
const revision = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
const paths = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })) });
const maxCodeBytes = 1_000_000;
const revisionUrl = (entry: CatalogEntry) => `https://github.com/${entry.repo}/blob/${entry.commit}/${encodedPath(entry.path)}`;
const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function checkedResponse(url: string) {
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8000) });
  if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("Достигнут лимит запросов GitHub. Повторите обновление позже.");
  }
  if (!response.ok) throw new Error(`GitHub вернул HTTP ${response.status}.`);
  return response;
}

export async function refreshRepository(repo: string): Promise<CatalogEntry[]> {
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repo) || /\/(?:\.|\.\.)$/.test(repo)) {
    throw new Error("Укажите публичный репозиторий в формате владелец/репозиторий.");
  }
  const api = `https://api.github.com/repos/${repo}`;
  const json = async (url: string) => (await checkedResponse(url)).json();
  const info = repository.parse(await json(api));
  const head = revision.parse(await json(`${api}/commits/${encodeURIComponent(info.default_branch)}`));
  const listing = paths.parse(await json(`${api}/git/trees/${head.sha}?recursive=1`));
  if (listing.truncated) throw new Error("GitHub вернул неполное дерево. Выберите репозиторий меньшего размера.");
  return listing.tree.filter((file) => file.type === "blob" && /\.m?js$/i.test(file.path) &&
    (file.size ?? Infinity) <= maxCodeBytes).map((file) => ({
    name: file.path.split("/").pop()!, description: file.path, repo, path: file.path,
    commit: head.sha, author: repo.split("/")[0], license: info.license?.spdx_id ?? "Не определена",
    compatibility: "Не проверена",
  }));
}

export async function loadCatalogCode(entry: CatalogEntry) {
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
