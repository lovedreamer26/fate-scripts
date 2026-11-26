import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

export async function startInventory(origin, worldId) {
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || !['localhost','127.0.0.1'].includes(url.hostname) || !worldId) throw new Error('Требуется точный локальный Origin и ID мира.');
  const key = randomBytes(32).toString('hex');
  let consumed = false, accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const server = createServer({requestTimeout: 10000, headersTimeout: 5000}, async (req,res) => {
    const reply = status => res.writeHead(status).end();
    res.setHeader('Cache-Control','no-store');
    if (req.headers.origin !== origin || req.url !== '/fate-scripts/inventory/v2') return reply(403);
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods','POST');
      res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
      return reply(204);
    }
    const auth = req.headers.authorization;
    if (req.method !== 'POST' || typeof auth !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth.slice(7)),Buffer.from(key))) return reply(403);
    if (consumed) return reply(409);
    try {
      const chunks=[]; let size=0;
      for await (const chunk of req) { size+=chunk.length; if(size>16*1024*1024) { req.destroy(); return; } chunks.push(chunk); }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validInventory(data,origin,worldId)) return reply(400);
      if (consumed) return reply(409);
      consumed=true; reply(204); accept(data);
    } catch { if (!res.headersSent && !res.destroyed) reply(400); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const close=()=>{ clearTimeout(timer); server.closeAllConnections(); return new Promise(resolve=>server.close(()=>{accept(null);resolve();})); };
  const timer=setTimeout(()=>void close(),120000); timer.unref();
  return {endpoint:`http://127.0.0.1:${server.address().port}/fate-scripts/inventory/v2`,key,accepted,close};
}
function validInventory(d,origin,worldId) {
  const str=x=>typeof x==='string';
  const id=x=>str(x)&&x.length>0&&x.length<=256;
  const unique=(a,check)=>Array.isArray(a)&&a.length<=50000&&a.every(check)&&new Set(a.map(x=>x.id)).size===a.length;
  return d?.protocol===2&&d.serverOrigin===origin&&d.worldId===worldId&&id(d.userId)&&str(d.worldTitle)&&str(d.version)&&id(d.system?.id)&&str(d.system.version)&&
    unique(d.macros,m=>m&&id(m.id)&&str(m.name)&&str(m.type)&&str(m.img)&&str(m.command)&&(m.folderId===null||id(m.folderId)))&&
    unique(d.folders,f=>f&&id(f.id)&&str(f.name)&&(f.parentId===null||id(f.parentId)))&&
    unique(d.modules,m=>m&&id(m.id)&&str(m.version)&&typeof m.active==='boolean');
}
