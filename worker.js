const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',MAX_PLAYERS=5,ROOM_TTL=30*24*3600*1000;
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'};
const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{...CORS,'Content-Type':'application/json; charset=utf-8'}});
const fail=(m,s=400)=>json({error:m},s);
function makeCode(){const a=new Uint8Array(6);crypto.getRandomValues(a);return [...a].map(b=>ALPHABET[b%ALPHABET.length]).join('')}
function randomHex(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return [...a].map(b=>b.toString(16).padStart(2,'0')).join('')}
function cleanText(v,n){return String(v==null?'':v).replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,n)}
async function sha256(t){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function readBody(r){try{return await r.json()}catch(e){return {}}}

/* world format: vehicles {key:{phys,state}}, items {netId:item} (only player-dropped 'd:' items), removed [netId] */
const reg=env=>env.ROOMS.get(env.ROOMS.idFromName('__registry__'));
function normalizeWorld(w){
 const out={vehicles:{},items:{},removed:Array.isArray(w.removed)?w.removed.slice(-2000):[]};
 if(Array.isArray(w.vehicles)){for(const v of w.vehicles)if(v&&v.key)out.vehicles[v.key]={phys:v.phys||null,state:v.state||{}}}
 else if(w.vehicles&&typeof w.vehicles==='object')out.vehicles=w.vehicles;
 if(Array.isArray(w.items)){for(const it of w.items)if(it&&typeof it.netId==='string'&&it.netId.startsWith('d:'))out.items[it.netId]=it}
 else if(w.items&&typeof w.items==='object')out.items=w.items;
 return out;
}

export default {async fetch(request,env){
 const url=new URL(request.url);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(url.pathname==='/'||url.pathname==='/health')return json({ok:true,service:'long-road-rooms',version:7});

 if(request.method==='POST'&&url.pathname==='/api/create'){
  const b=await readBody(request),name=cleanText(b.name,18)||'بازیکن',roomName=cleanText(b.roomName,24)||'اتاق دوستان',passwordEnabled=!!b.passwordEnabled,password=String(b.password||'').slice(0,24),listed=b.listed!==false,roomId=randomHex(6);
  if(passwordEnabled&&password.length<4)return fail('رمز باید حداقل ۴ نویسه باشد.');
  for(let i=0;i<6;i++){
   const code=makeCode(),stub=env.ROOMS.get(env.ROOMS.idFromName(code));
   const res=await stub.fetch('https://room/init',{method:'POST',body:JSON.stringify({roomName,passwordEnabled,password,name,cid:b.cid,roomId,listed})});
   if(res.status===409)continue;
