LONG ROAD 3D — پچ Worker برای فهرست سرورها، دعوت با کد و اخراج بازیکن

این فایل «Worker کامل جایگزین» نیست؛ قطعه‌های زیر باید در worker.js فعلی که فرستادی ادغام شوند. چون worker.js به‌صورت فایل جداگانه ضمیمه نشده، عمداً کل فایل را از روی متن ناقص بازسازی نکردم.

۱) در ابتدای fetch اصلی، قبل از مسیر /api/create، این دو مسیر را اضافه کن:

if (request.method==='GET' && url.pathname==='/api/rooms') {
  const dir=env.ROOMS.get(env.ROOMS.idFromName('__directory__'));
  return dir.fetch('https://room/directory/list');
}
if (request.method==='POST' && url.pathname==='/api/join-public') {
  const b=await readBody(request);
  const dir=env.ROOMS.get(env.ROOMS.idFromName('__directory__'));
  const rr=await dir.fetch('https://room/directory/resolve',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:String(b.publicId||'')})
  });
  const entry=await rr.json().catch(()=>({}));
  if(!rr.ok || !entry.code) return fail('این اتاق دیگر در فهرست نیست.',404);
  const stub=env.ROOMS.get(env.ROOMS.idFromName(entry.code));
  const joined=await stub.fetch('https://room/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    name:cleanText(b.name,18)||'بازیکن',password:String(b.password||''),invite:false,cid:b.cid
  })});
  const data=await joined.json().catch(()=>({}));
  if(!joined.ok) return fail(data.error||'ورود به اتاق انجام نشد.',joined.status);
  const proto=url.protocol==='https:'?'wss':'ws';
  return json({code:entry.code,roomName:data.roomName,wsUrl:proto+'://'+url.host+'/ws/'+entry.code+'?ticket='+data.ticket});
}

۲) در مسیر ساخت اتاق، هنگام فرستادن داده به /room/init، فیلد code را هم بفرست:

body:JSON.stringify({roomName,passwordEnabled,password,name,cid:b.cid,code})

بعد از این خط:
const r=await res.json(),proto=url.protocol==='https:'?'wss':'ws';

این قطعه را اضافه کن:

const dir=env.ROOMS.get(env.ROOMS.idFromName('__directory__'));
await dir.fetch('https://room/directory/upsert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  code,publicId:randomHex(12),roomName,ownerName:name,passwordEnabled,count:0,lastSeen:Date.now()
})});

۳) در مسیر POST /api/join، هنگام ارسال درخواست به Durable Object، invite را هم بفرست:

body:JSON.stringify({name:cleanText(b.name,18)||'بازیکن',password:String(b.password||''),invite:!!b.invite,cid:b.cid})

کد ورود مستقیم، وقتی invite=true باشد، مجوز دعوت محسوب می‌شود. ورود از فهرست عمومی از مسیر join-public می‌آید و invite=false است؛ بنابراین اتاق رمزدار همچنان رمز می‌خواهد.

۴) در کلاس Room، سازنده را این‌طور تغییر بده:

constructor(state,env){
  this.state=state;this.env=env;this.players=new Map();this.ownerId=null;this.cfg=null;this.loaded=false;
  this.worldState=normalizeWorld({});this.vehicleOwners=new Map();this.lastWorldPersist=0;this.dirty=false;
}

۵) در Room.fetch، قبل از /init این شرط را اضافه کن:

if(u.pathname.startsWith('/directory/')) return this.directoryFetch(request,u);

سپس این دو متد را داخل کلاس Room اضافه کن:

async directoryFetch(request,u){
  const cors={...CORS,'Content-Type':'application/json; charset=utf-8'};
  if(u.pathname==='/directory/upsert' && request.method==='POST'){
    const b=await readBody(request);
    if(!b.code || !b.publicId) return new Response(JSON.stringify({error:'bad entry'}),{status:400,headers:cors});
    await this.state.storage.put('dir:'+b.code,{code:b.code,publicId:b.publicId,roomName:cleanText(b.roomName,24),ownerName:cleanText(b.ownerName,18),passwordEnabled:!!b.passwordEnabled,count:Number(b.count)||0,lastSeen:Date.now()});
    return new Response(JSON.stringify({ok:true}),{headers:cors});
  }
  if(u.pathname==='/directory/update' && request.method==='POST'){
    const b=await readBody(request),key='dir:'+String(b.code||'');
    const old=await this.state.storage.get(key);
    if(!old)return new Response(JSON.stringify({ok:false}),{status:404,headers:cors});
    old.count=Math.max(0,Math.min(5,Number(b.count)||0));old.lastSeen=Date.now();
    await this.state.storage.put(key,old);
    if(old.count===0) await this.state.storage.delete(key);
    return new Response(JSON.stringify({ok:true}),{headers:cors});
  }
  if(u.pathname==='/directory/remove' && request.method==='POST'){
    const b=await readBody(request);await this.state.storage.delete('dir:'+String(b.code||''));
    return new Response(JSON.stringify({ok:true}),{headers:cors});
  }
  if(u.pathname==='/directory/resolve' && request.method==='POST'){
    const b=await readBody(request),all=await this.state.storage.list({prefix:'dir:'});
    for(const entry of all.values()) if(entry.publicId===String(b.id||'')) return new Response(JSON.stringify({code:entry.code}),{headers:cors});
    return new Response(JSON.stringify({error:'not found'}),{status:404,headers:cors});
  }
  if(u.pathname==='/directory/list' && request.method==='GET'){
    const all=await this.state.storage.list({prefix:'dir:'}),rooms=[],now=Date.now();
    for(const entry of all.values()){
      if(now-(entry.lastSeen||0)>90000 || entry.count<1) continue;
      const item={id:entry.publicId,roomName:entry.roomName,ownerName:entry.ownerName,count:entry.count,passwordEnabled:entry.passwordEnabled};
      if(!entry.passwordEnabled)item.code=entry.code;
      rooms.push(item);
    }
    return new Response(JSON.stringify({rooms}),{headers:cors});
  }
  return new Response(JSON.stringify({error:'not found'}),{status:404,headers:cors});
}

async directoryUpdate(){
  if(!this.cfg || !this.cfg.code)return;
  const dir=this.env.ROOMS.get(this.env.ROOMS.idFromName('__directory__'));
  const path=this.players.size?'/directory/update':'/directory/remove';
  await dir.fetch('https://room'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:this.cfg.code,count:this.players.size})});
}

۶) در Room.init، cfg را با اطلاعات زیر ذخیره کن:

this.cfg={code:cleanText(b.code,6),roomName:b.roomName,ownerName:cleanText(b.name,18),passwordEnabled:!!b.passwordEnabled,salt,hash:b.passwordEnabled?await sha256(salt+b.password):null,started:false};

۷) امضای issueTicket را تغییر بده و دعوت را در ticket ذخیره کن:

async issueTicket(name,owner,cid,invited=false){
  const t=randomHex(12);
  await this.state.storage.put('tk:'+t,{name,owner,invited:!!invited,cid:cleanText(cid,48),exp:Date.now()+60000});
  return t;
}

در init همان فراخوانی قبلی issueTicket(b.name,true,b.cid) درست است.

در join، شرط رمز را این‌طور کن:

if(this.cfg.hash && !b.invite && (await sha256(this.cfg.salt+b.password))!==this.cfg.hash)
  return Response.json({error:'رمز اتاق اشتباه است.'},{status:403});

و ticket را این‌طور بساز:

return Response.json({roomName:this.cfg.roomName,ticket:await this.issueTicket(b.name,false,cid,!!b.invite)});

۸) در پیام welcome داخل connect، فیلد showRoomCode را اضافه کن:

showRoomCode:!this.cfg.passwordEnabled || !!rec.owner || !!rec.invited

۹) پس از اضافه کردن بازیکن در connect، بعد از broadcast joined این را اجرا کن:

await this.directoryUpdate();

در onMessage، داخل شاخه ping پس از ارسال pong این را اضافه کن:

await this.directoryUpdate();

در پایان onLeave، بعد از broadcast و تغییر owner، این را اجرا کن:

await this.directoryUpdate();

۱۰) قابلیت اخراج را در onMessage اضافه کن (مثلاً قبل از شاخه start):

if(m.type==='kick' && id===this.ownerId){
  const targetId=String(m.target||''),target=this.players.get(targetId);
  if(!target || targetId===id)return;
  this.send(target.ws,{type:'kicked'});
  await this.onLeave(targetId);
  try{target.ws.close(4003,'kicked')}catch(e){}
  return;
}

نکته: مجوز اخراج فقط در سرور بررسی می‌شود؛ دکمه رابط کاربری به‌تنهایی امنیت ایجاد نمی‌کند.

۱۱) در Room.alarm، چون اتاق خالی منقضی شده است، قبل از deleteAll یا هم‌زمان با آن، directory entry را پاک کن:

await this.directoryUpdate();

سپس منطق فعلی alarm را نگه دار.

پس از ادغام، Worker را Deploy کن. رابط HTML جدید به این APIها نیاز دارد:
GET /api/rooms
POST /api/join-public
POST /api/join با فیلد invite
و پیام WebSocket نوع kick.
