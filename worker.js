/* LONG ROAD 3D - room server (Cloudflare Worker + Durable Objects)
   - ساخت اتاق با کد ۶ نویسه، رمز اختیاری، حداکثر ۵ بازیکن
   - هر بازیکن شناسه یکتا (cid) دارد
   - Heartbeat: بازیکنی که چند ثانیه پیام نفرستد حذف می‌شود
   - ورود مجدد همان بازیکن، بازیکن قبلی را جایگزین می‌کند (بدون تکرار)
   - خروج بازیکن برای همه پخش می‌شود
*/
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 5;
const STALE_MS = 20000;          // بدون هیچ پیامی بیش از این زمان => قطع شده
const REPLACE_STALE_MS = 6000;   // برای جایگزینی هم‌نام بدون cid
const SWEEP_MS = 5000;           // فاصله بررسی قطع‌شده‌ها
const EMPTY_TTL_MS = 10 * 60 * 1000; // اتاق خالی بعد از ۱۰ دقیقه پاک می‌شود
const TICKET_TTL_MS = 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });

const fail = (message, status = 400) => json({ error: message }, status);

/* ---------- helpers ---------- */
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
const cleanName = (n, def) => {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18);
  return s || def;
};
const cleanCid = c => String(c || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
const hex = (n) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
};
const genCode = () => {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, b => ALPHABET[b % ALPHABET.length]).join('');
};
const num = (v, lo, hi) => {
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
};
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
const stubOf = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
async function callRoom(env, code, path, payload) {
  const res = await stubOf(env, code).fetch('https://room.internal' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
const wsUrlFor = (url, code, ticket) => `wss://${url.host}/ws?code=${code}&ticket=${ticket}`;

/* ---------- worker entry ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'long-road-rooms' });

      if (url.pathname === '/api/create' && request.method === 'POST') {
        const b = await readBody(request);
        const roomName = cleanName(b.roomName, 'اتاق دوستان');
        const passwordEnabled = !!b.passwordEnabled;
        const password = String(b.password || '').slice(0, 24);
        if (passwordEnabled && password.length < 4) return fail('رمز باید حداقل ۴ نویسه باشد.');
        const name = cleanName(b.name, 'بازیکن');
        const cid = cleanCid(b.cid) || ('p' + hex(6));
        for (let i = 0; i < 6; i++) {
          const code = genCode();
          const r = await callRoom(env, code, '/init', { roomName, passwordEnabled, password, ownerCid: cid });
          if (r.status === 200) {
            const t = await callRoom(env, code, '/ticket', { name, cid, password });
            if (t.status !== 200) return fail(t.data.error || 'ساخت اتاق انجام نشد.', t.status);
            return json({ code, roomName, wsUrl: wsUrlFor(url, code, t.data.ticket) });
          }
          if (r.status !== 409) break;
        }
        return fail('ساخت اتاق انجام نشد؛ دوباره تلاش کن.', 500);
      }

      if (url.pathname === '/api/join' && request.method === 'POST') {
        const b = await readBody(request);
        const code = cleanCode(b.code);
        if (code.length !== 6) return fail('کد اتاق باید ۶ نویسه باشد.');
        const name = cleanName(b.name, 'بازیکن');
        const cid = cleanCid(b.cid) || ('p' + hex(6));
        const t = await callRoom(env, code, '/ticket', { name, cid, password: String(b.password || '') });
        if (t.status !== 200) return fail(t.data.error || 'ورود به اتاق ممکن نیست.', t.status);
        return json({ code, roomName: t.data.roomName, wsUrl: wsUrlFor(url, code, t.data.ticket) });
      }

      if (url.pathname === '/ws') {
        if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return fail('WebSocket لازم است.', 426);
        const code = cleanCode(url.searchParams.get('code'));
        if (code.length !== 6) return fail('کد اتاق نامعتبر است.');
        return stubOf(env, code).fetch(request);
      }

      return fail('یافت نشد.', 404);
    } catch (e) {
      return fail('خطای سرور', 500);
    }
  }
};

/* ---------- Durable Object: one room ---------- */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.meta = null;
    this.players = new Map();   // cid -> player
    this.tickets = new Map();   // ticket -> {name,cid,exp}
    this.started = false;
    this.ownerId = '';
    this.emptySince = Date.now();
    state.blockConcurrencyWhile(async () => {
      this.meta = (await state.storage.get('meta')) || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      if (this.meta) return json({ error: 'exists' }, 409);
      const b = await readBody(request);
      const salt = hex(8);
      this.meta = {
        roomName: cleanName(b.roomName, 'اتاق دوستان'),
        pwEnabled: !!b.passwordEnabled,
        salt,
        pwHash: b.passwordEnabled ? await sha256(salt + String(b.password || '')) : '',
        created: Date.now()
      };
      await this.state.storage.put('meta', this.meta);
      this.ownerId = cleanCid(b.ownerCid);
      this.emptySince = Date.now();
      await this.state.storage.setAlarm(Date.now() + SWEEP_MS);
      return json({ ok: true });
    }

    if (url.pathname === '/ticket') {
      if (!this.meta) return json({ error: 'اتاقی با این کد پیدا نشد.' }, 404);
      const b = await readBody(request);
      if (this.meta.pwEnabled) {
        const h = await sha256(this.meta.salt + String(b.password || ''));
        if (h !== this.meta.pwHash) return json({ error: 'رمز اتاق اشتباه است.' }, 403);
      }
      const cid = cleanCid(b.cid);
      if (!cid) return json({ error: 'شناسه بازیکن نامعتبر است.' }, 400);
      const others = this.players.size - (this.players.has(cid) ? 1 : 0);
      if (others >= MAX_PLAYERS) return json({ error: 'اتاق پر است (حداکثر ۵ بازیکن).' }, 403);
      const now = Date.now();
      for (const [k, v] of this.tickets) if (v.exp < now) this.tickets.delete(k);
      const ticket = hex(16);
      this.tickets.set(ticket, { name: cleanName(b.name, 'بازیکن'), cid, exp: now + TICKET_TTL_MS });
      return json({ ticket, roomName: this.meta.roomName });
    }

    if (url.pathname === '/ws') {
      if (!this.meta) return new Response('room not found', { status: 404 });
      const tk = this.tickets.get(url.searchParams.get('ticket') || '');
      if (!tk || tk.exp < Date.now()) return new Response('bad ticket', { status: 403 });
      this.tickets.delete(url.searchParams.get('ticket'));
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      await this.addPlayer(server, tk);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  pub(p) {
    return { id: p.id, name: p.name, ...p.data };
  }

  send(ws, obj) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  broadcast(exceptId, obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      try { if (p.ws.readyState === 1) p.ws.send(s); } catch (e) {}
    }
  }

  async addPlayer(ws, tk) {
    const now = Date.now();
    const id = tk.cid;
    const old = this.players.get(id);
    if (old) {
      // همان بازیکن دوباره وارد شد: اتصال قبلی جایگزین می‌شود، بازیکن تکراری ساخته نمی‌شود
      old.replaced = true;
      this.players.delete(id);
      try { old.ws.close(4000, 'replaced'); } catch (e) {}
    } else if (this.players.size >= MAX_PLAYERS) {
      this.send(ws, { type: 'error', message: 'اتاق پر است.' });
      try { ws.close(4002, 'full'); } catch (e) {}
      return;
    }
    const p = {
      id, name: tk.name, ws, lastSeen: now, lastState: 0, joinedAt: now, replaced: false,
      data: { x: 0, y: 0, z: 0, yaw: 0, mode: 'foot', skin: 0, vt: 'car', seat: 0, ride: '', sl: 0 }
    };
    this.players.set(id, p);
    this.emptySince = 0;
    const prevOwner = this.ownerId;
    if (!this.ownerId || !this.players.has(this.ownerId)) this.ownerId = id;

    ws.addEventListener('message', ev => this.onMessage(p, ev));
    ws.addEventListener('close', () => this.onGone(p));
    ws.addEventListener('error', () => this.onGone(p));

    this.send(ws, {
      type: 'welcome', id, isOwner: this.ownerId === id, ownerId: this.ownerId, roomName: this.meta.roomName,
      started: this.started, count: this.players.size,
      players: [...this.players.values()].filter(q => q.id !== id).map(q => this.pub(q))
    });
    this.broadcast(id, { type: 'joined', player: this.pub(p), count: this.players.size });
    if (prevOwner !== this.ownerId) this.broadcast(id, { type: 'owner', id: this.ownerId });
    try { await this.state.storage.setAlarm(now + SWEEP_MS); } catch (e) {}
  }

  onGone(p) {
    if (p.replaced || this.players.get(p.id) !== p) return;
    this.removePlayer(p);
  }

  removePlayer(p) {
    if (this.players.get(p.id) === p) this.players.delete(p.id);
    p.replaced = true;
    if (this.ownerId === p.id) {
      const n = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.ownerId = n ? n.id : '';
    }
    this.broadcast(null, { type: 'left', id: p.id, count: this.players.size });
    if (this.ownerId) this.broadcast(null, { type: 'owner', id: this.ownerId });
    if (!this.players.size) {
      this.started = false;
      this.emptySince = Date.now();
    }
  }

  onMessage(p, ev) {
    if (typeof ev.data !== 'string' || ev.data.length > 2000) return;
    if (this.players.get(p.id) !== p) return;
    const now = Date.now();
    p.lastSeen = now;
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ping':
        this.send(p.ws, { type: 'pong', t: now });
        break;
      case 'state': {
        if (now - p.lastState < 25) return;
        p.lastState = now;
        p.data = {
          x: num(m.x, -1e6, 1e6), y: num(m.y, -1000, 1000), z: num(m.z, -1e6, 1e6),
          yaw: num(m.yaw, -1000, 1000),
          mode: m.mode === 'car' ? 'car' : 'foot',
          skin: Math.round(num(m.skin, 0, 9)),
          vt: (m.vt === 'moto' || m.vt === 'truck') ? m.vt : 'car',
          seat: Math.round(num(m.seat, 0, 4)),
          ride: String(m.ride || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
          sl: m.sl ? 1 : 0
        };
        this.broadcast(p.id, { type: 'state', player: this.pub(p) });
        break;
      }
      case 'start':
        if (p.id === this.ownerId && this.players.size >= 2 && !this.started) {
          this.started = true;
          this.broadcast(null, { type: 'start' });
        }
        break;
      case 'bye':
        this.removePlayer(p);
        try { p.ws.close(1000, 'bye'); } catch (e) {}
        break;
    }
  }

  async alarm() {
    const now = Date.now();
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeen > STALE_MS) {
        this.removePlayer(p);
        try { p.ws.close(4001, 'stale'); } catch (e) {}
      }
    }
    for (const [k, v] of this.tickets) if (v.exp < now) this.tickets.delete(k);
    if (this.players.size) {
      await this.state.storage.setAlarm(now + SWEEP_MS);
      return;
    }
    if (!this.emptySince) this.emptySince = now;
    if (this.meta && now - this.emptySince > EMPTY_TTL_MS) {
      await this.state.storage.deleteAll();
      this.meta = null;
      this.ownerId = '';
      this.started = false;
      return;
    }
    if (this.meta) await this.state.storage.setAlarm(now + SWEEP_MS * 6);
  }
}
