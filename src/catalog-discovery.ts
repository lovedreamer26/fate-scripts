import { z } from "zod";
import { checkedResponse, GitHubHttpError, GitHubRateLimitError, IncompleteRepositoryError } from "./catalog";
import presets from "./catalog-search-presets.json";

export { presets };

const starterRepositories = [
  "Maselkov/masels-foundryvtt-macros",
  "thatlonelybugbear/FoundryMacros",
  "foundry-vtt-community/macros",
  "trioderegion/fvtt-macros",
];

const storageKey = "catalog.discovery.queue.v1";
const repoName = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i;
const pageSize = 10;
const maxPages = 2;
const queueSchema = z.object({
  queries: z.array(z.string()).max(26),
  queryIndex: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(maxPages),
  pending: z.array(z.string().regex(repoName)),
  processed: z.array(z.string()),
  found: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  retryAt: z.number().int().nonnegative(),
});
export type DiscoveryQueue = z.infer<typeof queueSchema>;

export function composeQueries(selected: string[], custom: string) {
  const queries = new Map<string, string>();
  for (const query of [...presets.filter(preset => selected.includes(preset.id)).flatMap(preset => preset.queries), custom.slice(0, 180)]) {
    const clean = query.trim().replace(/\s+/g, " ");
    if (clean && !queries.has(clean.toLowerCase())) queries.set(clean.toLowerCase(), clean);
  }
  return [...queries.values()];
}

export function initialQueue(queries: string[], includeStarters = false): DiscoveryQueue {
  return {queries, queryIndex:0, page:1, pending:includeStarters ? [...starterRepositories] : [],
    processed:[], found:0, skipped:0, retryAt:0};
}

export function readQueue(): DiscoveryQueue | undefined {
  try {
    const parsed = queueSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch { /* A missing or invalid checkpoint starts a fresh search. */ }
}

export function saveQueue(queue: DiscoveryQueue) {
  localStorage.setItem(storageKey, JSON.stringify(queue));
}

export function queueFinished(queue: DiscoveryQueue) {
  return queue.queryIndex >= queue.queries.length && !queue.pending.length;
}

const searchResult = z.object({total_count:z.number(), items:z.array(z.object({
  full_name:z.string(), description:z.string().nullable(), topics:z.array(z.string()).optional(),
  private:z.boolean(), archived:z.boolean(),
}))});

// GitHub ranks keyword matches across repository metadata and README. Add a D&D
// preference within each page without excluding Foundry-wide utilities.
function relevance(repo: z.infer<typeof searchResult>["items"][number]) {
  const text = [repo.full_name, repo.description, ...(repo.topics ?? [])].join(" ");
  return Number(/\b(?:dnd[- ]?5e|dnd5|d&d[- ]?5e|5e|midi[- ]qol)\b/i.test(text)) * 4 +
    Number(/\b(?:foundry|fvtt)\b/i.test(text)) * 2 + Number(/macros?/i.test(text));
}

async function discover(query: string, page: number, signal: AbortSignal) {
  const url = new URL("https://api.github.com/search/repositories");
  url.search = new URLSearchParams({
    q: `${query} in:name,description,readme is:public archived:false`,
    per_page: String(pageSize), page: String(page),
  }).toString();
  const response = await checkedResponse(url.href, undefined, signal);
  const result = searchResult.parse(await response.json());
  return {
    repos: result.items.filter(repo => !repo.private && !repo.archived && repoName.test(repo.full_name) &&
      !/\/(?:\.|\.\.)$/.test(repo.full_name)).sort((a,b) => relevance(b) - relevance(a)).map(repo => repo.full_name),
    more: page < maxPages && result.total_count > page * pageSize && result.items.length === pageSize,
  };
}

export async function runDiscovery(
  start: DiscoveryQueue,
  signal: AbortSignal,
  index: (repo: string, signal: AbortSignal) => Promise<number>,
  checkpoint: (queue: DiscoveryQueue) => void,
  activity: (label: string) => void,
) {
  let queue = {...start,retryAt:0};
  checkpoint(queue);
  const seen = new Set(queue.processed);
  try {
    while (!queueFinished(queue)) {
      signal.throwIfAborted();
      const [repo,...remaining] = queue.pending;
      if (repo) {
        activity(repo);
        let count = 0, skipped = 0;
        try { count = await index(repo, signal); }
        catch (error) {
          const unavailable = error instanceof GitHubHttpError && [404,409,410,422,451].includes(error.status);
          if (signal.aborted || !unavailable && !(error instanceof IncompleteRepositoryError) && !(error instanceof z.ZodError)) throw error;
          skipped = 1;
        }
        seen.add(repo.toLowerCase());
        queue = {...queue,pending:remaining,processed:[...seen],found:queue.found+count,skipped:queue.skipped+skipped};
      } else {
        const query = queue.queries[queue.queryIndex];
        activity(query);
        const result = await discover(query,queue.page,signal);
        const byKey = new Map<string,string>();
        for (const name of result.repos) {
          const key = name.toLowerCase();
          if (!seen.has(key) && !byKey.has(key)) byKey.set(key,name);
        }
        queue = {...queue,pending:[...byKey.values()],page:result.more ? queue.page+1 : 1,
          queryIndex:queue.queryIndex+Number(!result.more)};
      }
      checkpoint(queue);
    }
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      checkpoint({...queue,retryAt:error.retryAt});
      return "GitHub приостановил запросы. Найденные макросы доступны в каталоге.";
    }
    if (signal.aborted) return "Поиск остановлен. Очередь сохранена.";
    const reason = error instanceof Error ? error.message : String(error);
    return `Поиск приостановлен. ${reason}`;
  }
  return "Поиск завершён.";
}
