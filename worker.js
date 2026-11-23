/* LONG ROAD 3D - room server (Cloudflare Worker + Durable Objects)
   - ساخت اتاق با کد ۶ نویسه، رمز اختیاری، حداکثر ۵ بازیکن
   - هر بازیکن شناسه یکتا دارد
   - Heartbeat: بازیکنی که چند ثانیه پیام نفرستد حذف می‌شود
   - ورود مجدد همان بازیکن، بازیکن قبلی را جایگزین می‌کند (بدون تکرار)
   - خروج بازیکن برای همه پخش می‌شود
*/
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 5;
const STALE_MS = 20000;          // بدون هیچ پیامی بیش از این زمان => قطع شده
const REPLACE_STALE_MS = 6000;   // برای جایگزینی هم‌نام بدون clientId
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
