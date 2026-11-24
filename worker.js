/* LONG ROAD 3D - STABLE MOVEMENT v4 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });

const fail = (message, status = 400) => json({ error: message }, status);

function makeCode() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map(b => ALPHABET[b % ALPHABET.length]).join('');
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, max);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  );

  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'long-road-rooms'
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/create') {
      const body = await readBody(request);

      const name = cleanText(body.name, 18) || 'بازیکن';
      const roomName = cleanText(body.roomName, 24) || 'اتاق دوستان';
      const passwordEnabled = !!body.passwordEnabled;
      const password = String(body.password || '').slice(0, 24);

      if (passwordEnabled && password.length < 4) {
        return fail('رمز باید حداقل ۴ نویسه باشد.');
      }

      for (let i = 0; i < 6; i++) {
        const code = makeCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

        const res = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({
            roomName,
            passwordEnabled,
            password,
            name,
            cid: body.cid
          })
        });

        if (res.status === 409) continue;
        if (!res.ok) return fail('ساخت اتاق انجام نشد.', 500);

        const r = await res.json();
        const proto = url.protocol === 'https:' ? 'wss' : 'ws';

        return json({
          code,
          roomName,
          wsUrl: proto + '://' + url.host +
            '/ws/' + code + '?ticket=' + r.ticket
        });
      }

      return fail('ساخت اتاق انجام نشد؛ دوباره تلاش کن.', 500);
    }

    if (request.method === 'POST' && url.pathname === '/api/join') {
      const body = await readBody(request);
      const code = String(body.code || '').trim().toUpperCase();

      if (!/^[A-Z0-9]{6}$/.test(code)) {
        return fail('کد اتاق باید ۶ نویسه باشد.');
      }

      const name = cleanText(body.name, 18) || 'بازیکن';
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

      const res = await stub.fetch('https://room/join', {
        method: 'POST',
        body: JSON.stringify({
          name,
          password: String(body.password || ''),
          cid: body.cid
        })
      });

      const r = await res.json().catch(() => ({}));

      if (!res.ok) {
        return fail(r.error || 'ورود به اتاق انجام نشد.', res.status);
      }

      const proto = url.protocol === 'https:' ? 'wss' : 'ws';

      return json({
        code,
        roomName: r.roomName,
        wsUrl: proto + '://' + url.host +
          '/ws/' + code + '?ticket=' + r.ticket
      });
    }

    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);

    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return fail('WebSocket لازم است.', 426);
      }

      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }

    return fail('پیدا نشد.', 404);
  }
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.players = new Map();
    this.ownerId = null;
    this.cfg = null;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;

    this.cfg = (await this.state.storage.get('cfg')) || null;
    this.loaded = true;
  }

  async fetch(request) {
    await this.load();

    const url = new URL(request.url);

    if (url.pathname === '/init') return this.init(request);
    if (url.pathname === '/join') return this.join(request);
    if (url.pathname.startsWith('/ws/')) return this.connect(url);

    return new Response('not found', { status: 404 });
  }

  async issueTicket(name, owner, cid) {
    const t = randomHex(12);

    await this.state.storage.put('tk:' + t, {
      name,
      owner,
      cid: cleanText(cid, 48),
      exp: Date.now() + 60000
    });

    return t;
  }

  async init(request) {
    if (this.cfg) {
      return new Response('exists', { status: 409 });
    }

    const b = await request.json();
    const salt = randomHex(8);

    this.cfg = {
      roomName: b.roomName,
      salt,
      hash: b.passwordEnabled
        ? await sha256(salt + b.password)
        : null,
      started: false
    };

    await this.state.storage.put('cfg', this.cfg);
    await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000);

    const ticket = await this.issueTicket(b.name, true, b.cid);

    return Response.json({ ticket });
  }

  async join(request) {
    if (!this.cfg) {
      return Response.json(
        { error: 'اتاقی با این کد پیدا نشد.' },
        { status: 404 }
      );
    }

    const b = await request.json();

    if (
      this.cfg.hash &&
      (await sha256(this.cfg.salt + b.password)) !== this.cfg.hash
    ) {
      return Response.json(
        { error: 'رمز اتاق اشتباه است.' },
        { status: 403 }
      );
    }

    const cid = cleanText(b.cid, 48);

    const alreadyHere = cid &&
      [...this.players.values()].some(p => p.cid === cid);

    if (this.players.size >= MAX_PLAYERS && !alreadyHere) {
      return Response.json(
        { error: 'اتاق پر است (حداکثر ۵ نفر).' },
        { status: 409 }
      );
    }

    const ticket = await this.issueTicket(b.name, false, cid);

    return Response.json({
      roomName: this.cfg.roomName,
      ticket
    });
  }

  async connect(url) {
    if (!this.cfg) {
      return new Response('room not found', { status: 404 });
    }

    const t = url.searchParams.get('ticket') || '';
    const rec = await this.state.storage.get('tk:' + t);

    if (!rec || rec.exp < Date.now()) {
      return new Response('bad ticket', { status: 403 });
    }

    await this.state.storage.delete('tk:' + t);

    // Replace an older connection from the same device.
    if (rec.cid) {
      const old = [...this.players.entries()]
        .find(([, p]) => p.cid === rec.cid);

      if (old) {
        const [oldId, oldPlayer] = old;
        const wasOwner = this.ownerId === oldId;

        if (wasOwner) rec.owner = true;

        await this.onLeave(oldId);

        try {
          oldPlayer.ws.close(4001, 'reconnected');
        } catch (e) {}
      }
    }

    if (this.players.size >= MAX_PLAYERS) {
      return new Response('room full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    const id = randomHex(5);

    const data = {
      id,
      name: rec.name,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      mode: 'foot',
      skin: 0,
      vt: 'car',
      seat: 0
    };

    this.players.set(id, {
      ws: server,
      data,
      last: 0,
      lastWorld: 0,
      cid: rec.cid || ''
    });

    if (rec.owner || !this.players.has(this.ownerId)) {
      this.ownerId = id;
    }

    const others = [...this.players.values()]
      .filter(p => p.data.id !== id)
      .map(p => p.data);

    this.send(server, {
      type: 'welcome',
      id,
      isOwner: this.ownerId === id,
      roomName: this.cfg.roomName,
      started: this.cfg.started,
      players: others,
      count: this.players.size
    });

    this.broadcast(id, {
      type: 'joined',
      player: data,
      count: this.players.size
    });

    server.addEventListener('message', ev => this.onMessage(id, ev));

    const leave = () => this.onLeave(id);

    server.addEventListener('close', leave);
    server.addEventListener('error', leave);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  num(v, lim) {
    v = Number(v);

    return Number.isFinite(v)
      ? Math.max(-lim, Math.min(lim, v))
      : 0;
  }

  onMessage(id, ev) {
    const p = this.players.get(id);

    if (!p || typeof ev.data !== 'string' || ev.data.length > 600) {
      return;
    }

    let msg;

    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }

    if (msg.type === 'ping') {
      this.send(p.ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'bye') {
      this.onLeave(id);

      try {
        p.ws.close(1000, 'left');
      } catch (e) {}

      return;
    }

    if (msg.type === 'state') {
      const now = Date.now();

      if (now - p.last < 25) return;
      p.last = now;

      const d = p.data;

      d.x = this.num(msg.x, 1e6);
      d.y = this.num(msg.y, 1000);
      d.z = this.num(msg.z, 1e6);
      d.yaw = this.num(msg.yaw, 100);

      d.mode = msg.mode === 'car' ? 'car' : 'foot';

      d.skin = Math.max(
        0,
        Math.min(3, Math.floor(Number(msg.skin) || 0))
      );

      d.vt = msg.vt === 'moto' || msg.vt === 'truck'
        ? msg.vt
        : 'car';

      d.seat = Math.max(
        0,
        Math.min(4, Math.floor(Number(msg.seat) || 0))
      );

      this.broadcast(id, {
        type: 'state',
        player: d
      });

    } else if (msg.type === 'start') {
      if (
        id === this.ownerId &&
        this.players.size >= 2 &&
        !this.cfg.started
      ) {
        this.cfg.started = true;

        this.state.storage.put('cfg', this.cfg);

        this.broadcast(null, {
          type: 'start'
        });
      }
    }
  }

  async onLeave(id) {
    if (!this.players.delete(id)) return;

    this.broadcast(null, {
      type: 'left',
      id,
      count: this.players.size
    });

    if (this.ownerId === id) {
      const next = this.players.keys().next().value;

      this.ownerId = next || null;

      if (next) {
        this.send(this.players.get(next).ws, {
          type: 'owner'
        });
      }
    }

    if (this.players.size === 0) {
      await this.state.storage.setAlarm(
        Date.now() + 2 * 60 * 1000
      );
    }
  }

  async alarm() {
    await this.load();

    if (this.players.size === 0) {
      await this.state.storage.deleteAll();
      this.cfg = null;
    } else {
      await this.state.storage.setAlarm(
        Date.now() + 10 * 60 * 1000
      );
    }
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }

  broadcast(exceptId, obj) {
    const text = JSON.stringify(obj);

    for (const [pid, p] of this.players) {
      if (pid === exceptId) continue;

      try {
        p.ws.send(text);
      } catch (e) {}
    }
  }
}
