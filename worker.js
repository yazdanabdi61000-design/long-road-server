/* LONG ROAD 3D - room server (Cloudflare Worker + Durable Objects)
   Anyone can create a room (6-char code, optional password, max 5 players).
*/
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
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
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
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'long-road-rooms' });
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
            name
          })
        });

        if (res.status === 409) continue;
        if (!res.ok) return fail('ساخت اتاق انجام نشد.', 500);

        const r = await res.json();
        const proto = url.protocol === 'https:' ? 'wss' : 'ws';

        return json({
          code,
          roomName,
          wsUrl: proto + '://' + url.host + '/ws/' + code + '?ticket=' + r.ticket
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
          password: String(body.password || '')
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
        wsUrl: proto + '://' + url.host + '/ws/' + code + '?ticket=' + r.ticket
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
    this.emptyAt = 0;
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

  async issueTicket(name, owner) {
    const t = randomHex(12);
    await this.state.storage.put('tk:' + t, {
      name,
      owner,
      exp: Date.now() + 60
