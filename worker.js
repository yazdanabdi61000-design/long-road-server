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
 if(url.pathname==='/'||url.pathname==='/health')return json({ok:true,service:'long-road-rooms',version:6});

 if(request.method==='POST'&&url.pathname==='/api/create'){
  const b=await readBody(request),name=cleanText(b.name,18)||'بازیکن',roomName=cleanText(b.roomName,24)||'اتاق دوستان',passwordEnabled=!!b.passwordEnabled,password=String(b.password||'').slice(0,24);
  if(passwordEnabled&&password.length<4)return fail('رمز باید حداقل ۴ نویسه باشد.');
  for(let i=0;i<6;i++){
   const code=makeCode(),stub=env.ROOMS.get(env.ROOMS.idFromName(code));
   const res=await stub.fetch('https://room/init',{method:'POST',body:JSON.stringify({roomName,passwordEnabled,password,name,cid:b.cid})});
   if(res.status===409)continue;
   if(!res.ok)return fail('ساخت اتاق انجام نشد.',500);
   const r=await res.json(),proto=url.protocol==='https:'?'wss':'ws';
   return json({code,roomName,wsUrl:proto+'://'+url.host+'/ws/'+code+'?ticket='+r.ticket});
  }
  return fail('ساخت اتاق انجام نشد؛ دوباره تلاش کن.',500);
 }

 if(request.method==='POST'&&url.pathname==='/api/join'){
  const b=await readBody(request),code=String(b.code||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{6}$/.test(code))return fail('کد اتاق باید ۶ نویسه باشد.');
  const stub=env.ROOMS.get(env.ROOMS.idFromName(code));
  const res=await stub.fetch('https://room/join',{method:'POST',body:JSON.stringify({name:cleanText(b.name,18)||'بازیکن',password:String(b.password||''),cid:b.cid})});
  const r=await res.json().catch(()=>({}));
  if(!res.ok)return fail(r.error||'ورود به اتاق انجام نشد.',res.status);
  const proto=url.protocol==='https:'?'wss':'ws';
  return json({code,roomName:r.roomName,wsUrl:proto+'://'+url.host+'/ws/'+code+'?ticket='+r.ticket});
 }

 const m=url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
 if(m){
  if(request.headers.get('Upgrade')!=='websocket')return fail('WebSocket لازم است.',426);
  return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
 }
 return fail('پیدا نشد.',404);
}};

export class Room{
 constructor(state,env){
  this.state=state;this.players=new Map();this.ownerId=null;this.cfg=null;this.loaded=false;
  this.worldState=normalizeWorld({});this.vehicleOwners=new Map();this.lastWorldPersist=0;this.dirty=false;
 }

 async load(){
  if(this.loaded)return;
  this.cfg=await this.state.storage.get('cfg')||null;
  this.worldState=normalizeWorld(await this.state.storage.get('worldState')||{});
  this.loaded=true;
 }

 async persist(force){
  if(!this.dirty)return;
  if(!force&&Date.now()-this.lastWorldPersist<1500)return;
  this.lastWorldPersist=Date.now();this.dirty=false;
  await this.state.storage.put('worldState',this.worldState);
 }

 worldPayload(){
  const w=this.worldState;
  return{type:'world',
   vehicles:Object.keys(w.vehicles).map(k=>({key:k,phys:w.vehicles[k].phys,state:w.vehicles[k].state})),
   items:Object.values(w.items),removed:w.removed};
 }

 async fetch(request){
  await this.load();
  const u=new URL(request.url);
  if(u.pathname==='/init')return this.init(request);
  if(u.pathname==='/join')return this.join(request);
  if(u.pathname.startsWith('/ws/'))return this.connect(u);
  return new Response('not found',{status:404});
 }

 async issueTicket(name,owner,cid){
  const t=randomHex(12);
  await this.state.storage.put('tk:'+t,{name,owner,cid:cleanText(cid,48),exp:Date.now()+60000});
  return t;
 }

 async init(request){
  if(this.cfg)return new Response('exists',{status:409});
  const b=await request.json(),salt=randomHex(8);
  this.cfg={roomName:b.roomName,salt,hash:b.passwordEnabled?await sha256(salt+b.password):null,started:false};
  await this.state.storage.put('cfg',this.cfg);
  await this.state.storage.setAlarm(Date.now()+600000);
  return Response.json({ticket:await this.issueTicket(b.name,true,b.cid)});
 }

 async join(request){
  if(!this.cfg)return Response.json({error:'اتاقی با این کد پیدا نشد.'},{status:404});
  const b=await request.json(),cid=cleanText(b.cid,48);
  if(this.cfg.hash&&(await sha256(this.cfg.salt+b.password))!==this.cfg.hash)
   return Response.json({error:'رمز اتاق اشتباه است.'},{status:403});
  const same=cid&&[...this.players.values()].some(p=>p.cid===cid);
  if(this.players.size>=MAX_PLAYERS&&!same)
   return Response.json({error:'اتاق پر است (حداکثر ۵ نفر).'},{status:409});
  return Response.json({roomName:this.cfg.roomName,ticket:await this.issueTicket(b.name,false,cid)});
 }

 async connect(url){
  if(!this.cfg)return new Response('room not found',{status:404});
  const t=url.searchParams.get('ticket')||'',rec=await this.state.storage.get('tk:'+t);
  if(!rec||rec.exp<Date.now())return new Response('bad ticket',{status:403});
  await this.state.storage.delete('tk:'+t);

  if(rec.cid){
   const old=[...this.players.entries()].find(([,p])=>p.cid===rec.cid);
   if(old){
    const [oid,op]=old;
    if(this.ownerId===oid)rec.owner=true;
    await this.onLeave(oid);
    try{op.ws.close(4001,'reconnected')}catch(e){}
   }
  }

  if(this.players.size>=MAX_PLAYERS)return new Response('room full',{status:409});
  const saved=rec.cid?(await this.state.storage.get('pd:'+rec.cid))||null:null;
  const pair=new WebSocketPair(),client=pair[0],server=pair[1];
  server.accept();
  const id=randomHex(5);
  const data={id,name:rec.name,x:0,y:0,z:0,yaw:0,mode:'foot',skin:0,vt:'car',seat:0,ride:'',sl:0,held:'',heldCol:null,vehKey:'',tod:0.33,sit:0,an:'',rad:0,rx:0,rz:0};
  this.players.set(id,{ws:server,data,last:0,cid:rec.cid||''});
  if(rec.owner||!this.ownerId||!this.players.has(this.ownerId))this.ownerId=id;

  const others=[...this.players.values()].filter(p=>p.data.id!==id).map(p=>p.data);
  this.send(server,{type:'welcome',id,isOwner:this.ownerId===id,ownerId:this.ownerId,roomName:this.cfg.roomName,started:this.cfg.started,players:others,count:this.players.size,saved});

  const w=this.worldState;
  if(Object.keys(w.vehicles).length||Object.keys(w.items).length||w.removed.length)
   this.send(server,this.worldPayload());

  this.broadcast(id,{type:'joined',player:data,count:this.players.size});
  server.addEventListener('message',ev=>this.onMessage(id,ev));
  const leave=()=>this.onLeave(id);
  server.addEventListener('close',leave);
  server.addEventListener('error',leave);
  return new Response(null,{status:101,webSocket:client});
 }

 num(v,l){
  v=Number(v);
  return Number.isFinite(v)?Math.max(-l,Math.min(l,v)):0;
 }

 async onMessage(id,ev){
  const p=this.players.get(id);
  if(!p||typeof ev.data!=='string'||ev.data.length>100000)return;
  let m;
  try{m=JSON.parse(ev.data)}catch(e){return}

  if(m.type==='ping'){this.send(p.ws,{type:'pong'});await this.persist(false);return}
  if(m.type==='bye'){
   this.onLeave(id);
   try{p.ws.close(1000,'left')}catch(e){}
   return;
  }

  if(m.type==='name'){
   const nm=cleanText(m.name,18);
   if(nm){p.data.name=nm;this.broadcast(id,{type:'state',player:p.data})}
   return;
  }

  /* per-player saved inventory, kept per client id so it survives leaving the room */
  if(m.type==='save'){
   if(p.cid&&m.data&&typeof m.data==='object'){
    const s=JSON.stringify(m.data);
    if(s.length<8000)await this.state.storage.put('pd:'+p.cid,m.data);
   }
   return;
  }

  /* WebRTC signalling (radio streaming between players) */
  if(m.type==='rtc'){
   const t=this.players.get(String(m.to||''));
   if(t&&typeof m.kind==='string')this.send(t.ws,{type:'rtc',from:id,kind:cleanText(m.kind,10),side:cleanText(m.side,2),data:m.data});
   return;
  }

  if(m.type==='state'){
   if(Date.now()-p.last<25)return;
   p.last=Date.now();
   const mode=m.mode==='car'?'car':'foot';
   const seat=Math.max(0,Math.min(4,Math.floor(Number(m.seat)||0)));
   const key=cleanText(m.vehKey,100);

   if(mode==='car'&&seat===0&&key){
    const by=this.vehicleOwners.get(key);
    if(by&&by!==id){
     this.send(p.ws,{type:'vehicle_busy',key});
     return;
    }
    this.vehicleOwners.set(key,id);
   }else if(p.data.vehKey&&this.vehicleOwners.get(p.data.vehKey)===id){
    this.vehicleOwners.delete(p.data.vehKey);
   }

   Object.assign(p.data,{
    x:this.num(m.x,1e6),y:this.num(m.y,1000),z:this.num(m.z,1e6),
    yaw:this.num(m.yaw,100),mode,
    skin:Math.max(0,Math.min(3,Math.floor(Number(m.skin)||0))),
    vt:m.vt==='moto'?'moto':m.vt==='truck'?'truck':'car',
    seat,ride:cleanText(m.ride,32),sl:m.sl?1:0,
    held:cleanText(m.held,32),
    heldCol:typeof m.heldCol==='string'?cleanText(m.heldCol,16):null,
    vehKey:key,tod:this.num(m.tod,1),
    sit:m.sit?1:0,an:cleanText(m.an,16),
    rad:m.rad?1:0,rx:this.num(m.rx,1e6),rz:this.num(m.rz,1e6)
   });
   this.broadcast(id,{type:'state',player:p.data});
   return;
  }

  /* world: only changes (deltas) are stored and relayed */
  if(m.type==='world'){
   const w=this.worldState,remSet=new Set(w.removed),dv=[],di=[],dr=[];

   for(const x of (Array.isArray(m.removed)?m.removed.slice(0,300):[])){
    if(typeof x!=='string'||x.length>180||remSet.has(x))continue;
    remSet.add(x);w.removed.push(x);dr.push(x);delete w.items[x];
   }
   if(w.removed.length>3000)w.removed.splice(0,w.removed.length-2000);

   for(const x of (Array.isArray(m.items)?m.items.slice(0,120):[])){
    if(!x||typeof x.netId!=='string'||x.netId.length>180||!x.netId.startsWith('d:')||remSet.has(x.netId))continue;
    if(typeof x.type!=='string'||!/^[a-zA-Z0-9:_-]+$/.test(x.type))continue;
    const it={netId:x.netId,type:x.type,
     x:this.num(x.x,1e6),y:this.num(x.y,1000),z:this.num(x.z,1e6),
     ry:this.num(x.ry,100),uses:this.num(x.uses,10000),
     col:typeof x.col==='string'?cleanText(x.col,16):null};
    w.items[x.netId]=it;di.push(it);
   }
   const ik=Object.keys(w.items);
   if(ik.length>500)for(const k of ik.slice(0,ik.length-500))delete w.items[k];

   for(const x of (Array.isArray(m.vehicles)?m.vehicles.slice(0,12):[])){
    if(!x||typeof x.key!=='string'||x.key.length>100)continue;
    const e=w.vehicles[x.key]||(w.vehicles[x.key]={phys:null,state:{}}),out={key:x.key};
    if(x.state&&typeof x.state==='object'&&JSON.stringify(x.state).length<20000){
     Object.assign(e.state,x.state);out.state=x.state;
    }
    if(x.phys&&typeof x.phys==='object'){
     const by=this.vehicleOwners.get(x.key);
     if(!by||by===id){
      const ph=x.phys;
      e.phys={x:this.num(ph.x,1e6),y:this.num(ph.y,1000),z:this.num(ph.z,1e6),psi:this.num(ph.psi,100),v:this.num(ph.v,1000),steer:this.num(ph.steer,10)};
      out.phys=e.phys;
     }
    }
    if(out.state||out.phys)dv.push(out);
   }
   const vk=Object.keys(w.vehicles);
   if(vk.length>150)for(const k of vk.slice(0,vk.length-150))delete w.vehicles[k];

   if(dv.length||di.length||dr.length){
    this.dirty=true;
    await this.persist(false);
    this.broadcast(id,{type:'world',vehicles:dv,items:di,removed:dr});
   }
   return;
  }

  if(m.type==='start'&&id===this.ownerId&&this.players.size>=2&&!this.cfg.started){
   this.cfg.started=true;
   await this.state.storage.put('cfg',this.cfg);
   this.broadcast(null,{type:'start'});
  }
 }

 async onLeave(id){
  const p=this.players.get(id);
  if(!p||!this.players.delete(id))return;
  for(const [k,v] of this.vehicleOwners)if(v===id)this.vehicleOwners.delete(k);
  this.broadcast(null,{type:'left',id,count:this.players.size});
  if(this.ownerId===id){
   const next=this.players.keys().next().value;
   this.ownerId=next||null;
   if(next)this.send(this.players.get(next).ws,{type:'owner',id:next});
  }
  await this.persist(true);
  /* an empty room is kept for 30 days so friends can come back to the same world */
  if(!this.players.size)await this.state.storage.setAlarm(Date.now()+ROOM_TTL);
 }

 async alarm(){
  await this.load();
  if(!this.players.size){
   await this.state.storage.deleteAll();
   this.cfg=null;
   this.worldState=normalizeWorld({});
  }else await this.state.storage.setAlarm(Date.now()+600000);
 }

 send(ws,o){try{ws.send(JSON.stringify(o))}catch(e){}}

 broadcast(except,o){
  const t=JSON.stringify(o);
  for(const [id,p] of this.players){
   if(id===except)continue;
   try{p.ws.send(t)}catch(e){}
  }
 }
    }
