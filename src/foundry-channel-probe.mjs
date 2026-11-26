import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";

export async function startProbe(origin) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Для диагностического сервера нужен точный loopback Origin.");
  }
  const key = randomBytes(32).toString("hex");
  let consumed = false;
  let accept;
  const accepted = new Promise((resolve) => { accept = resolve; });
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reply = (status) => { res.writeHead(status).end(); };
    if (req.headers.origin !== origin || req.url !== "/fate-scripts/probe/v1") return reply(403);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return reply(204);
    }
    const provided = req.headers.authorization;
    if (req.method !== "POST" || typeof provided !== "string" || !/^Bearer [a-f0-9]{64}$/.test(provided) ||
        !timingSafeEqual(Buffer.from(provided.slice(7)), Buffer.from(key))) return reply(403);
    if (consumed) return reply(409);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { req.destroy(); return; }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data?.protocol !== 1 || typeof data.version !== "string" || data.version.length > 32 ||
          !Number.isSafeInteger(data.macroCount) || data.macroCount < 0 || !Number.isSafeInteger(data.moduleCount) ||
          data.moduleCount < 0) return reply(400);
      if (consumed) return reply(409);
      consumed = true;
      reply(204);
      accept({ protocol: data.protocol, version: data.version, macroCount: data.macroCount, moduleCount: data.moduleCount });
    } catch {
      if (!res.headersSent && !res.destroyed) reply(400);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/fate-scripts/probe/v1`,
    key, accepted,
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}
