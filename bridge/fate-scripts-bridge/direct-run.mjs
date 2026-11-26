// One-shot authenticated pull and report; never retry execution automatically.
export async function directRun({pairing, origin, worldId, run, fetcher=fetch, protocol=4}) {
  const m=/^([0-9]{1,5}):([a-f0-9]{64})$/.exec(pairing.trim());
  if(!m || +m[1]<1 || +m[1]>65535) throw Error('Некорректный код');
  const url=`http://127.0.0.1:${+m[1]}/fate-scripts/run/v1`;
  const opts={method:'POST',redirect:'error',credentials:'omit',headers:{Authorization:`Bearer ${m[2]}`,'Content-Type':'application/json'}};
  const response=await fetcher(url,{...opts,signal:AbortSignal.timeout(10000),body:JSON.stringify({action:'claim',origin,worldId,protocol})});
  if(!response.ok) throw Error(`Запрос отклонён: ${response.status}`);
  const p=await response.json();
  if(p.protocol!==protocol || p.origin!==origin || p.worldId!==worldId) throw Error('Неверный мир');
  let result;
  try {result=await run(p);} catch(e){result={runId:p.runId,worldId,status:'error',error:String(e.message).slice(0,4000)};}
  const ack=await fetcher(url,{...opts,signal:AbortSignal.timeout(10000),body:JSON.stringify({action:'report',origin,worldId,result})});
  if(!ack.ok) throw Error('Отчёт не принят; не повторяйте запуск автоматически');
  return result;
}
