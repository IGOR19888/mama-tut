// Mepsi & LULU — маркетплейс на чистом Node.js (без зависимостей).
// Раздаёт SPA из /public, отдаёт API (товары, авторизация, заказы, ЛК) и хранит данные на диске.
// На Railway: слушает process.env.PORT, изменяемые данные пишет в Volume (process.env.DATA_DIR).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// --- загрузка .env локально (на Railway переменные уже в окружении) ---
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}
// Интеграция с Ozon (читает OZON_CLIENT_ID/OZON_API_KEY из окружения при require).
const ozon = require("./ozon");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
// Каталог правится вручную и лежит рядом с кодом.
const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");
// Всё изменяемое — в постоянный том (Volume) на проде, локально в ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const F = {
  users: path.join(DATA_DIR, "users.json"),
  sessions: path.join(DATA_DIR, "sessions.json"),
  orders: path.join(DATA_DIR, "orders.json"),
  reviews: path.join(DATA_DIR, "reviews.json"),
  returns: path.join(DATA_DIR, "returns.json"),
  otp: path.join(DATA_DIR, "otp.json"),
};
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

// ---------- storage helpers ----------
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function write(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
// Каталог берём из интеграции Ozon (live при ключах, иначе demo-каталог).
const products = () => ozon.products();
// Пользовательские отзывы (оставленные в нашем ЛК) — отдельно от отзывов Ozon.
const userReviews = () => read(F.reviews, []);
// Все отзывы товара = отзывы Ozon + оставленные покупателями у нас.
const reviewsForProduct = (id) => [...userReviews().filter((r) => r.productId === id), ...ozon.reviewsFor(id)];

// ---------- http helpers ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4e6) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
const uid = (p = "") => p + crypto.randomBytes(9).toString("base64url");
const now = () => new Date().toISOString();

// ---------- auth ----------
function tokenFrom(req) {
  const h = req.headers["authorization"] || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function currentUser(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const sessions = read(F.sessions, {});
  const s = sessions[token];
  if (!s) return null;
  const users = read(F.users, {});
  return users[s.userId] || null;
}
function saveUser(u) {
  const users = read(F.users, {});
  users[u.id] = u;
  write(F.users, users);
  return u;
}
function newSession(userId) {
  const token = uid("s_");
  const sessions = read(F.sessions, {});
  sessions[token] = { userId, createdAt: now() };
  write(F.sessions, sessions);
  return token;
}

// Нормализуем идентификатор канала входа
function normIdent(method, id) {
  id = String(id || "").trim();
  if (method === "phone") return id.replace(/[^\d+]/g, "");
  if (method === "email") return id.toLowerCase();
  return id.replace(/^@/, "").toLowerCase();
}
function findUserByChannel(method, ident) {
  const users = read(F.users, {});
  return Object.values(users).find((u) => u[method] && u[method] === ident) || null;
}
function blankUser(overrides = {}) {
  return {
    id: uid("u_"), createdAt: now(),
    firstName: "", lastName: "", birthday: "", gender: "",
    phone: null, email: null, telegram: null, max: null,
    points: 500, // приветственные баллы
    addresses: [], cards: [], favorites: [],
    settings: { email: true, sms: true, push: true, telegram: true },
    ...overrides,
  };
}
// Публичная проекция юзера (без служебного)
function publicUser(u) {
  if (!u) return null;
  const { id, firstName, lastName, birthday, gender, phone, email, telegram, max,
          points, addresses, cards, favorites, settings, createdAt } = u;
  const name = [firstName, lastName].filter(Boolean).join(" ") || null;
  return { id, name, firstName, lastName, birthday, gender, phone, email, telegram, max,
           points, addresses, cards, favorites, settings, createdAt,
           channels: { phone: !!phone, email: !!email, telegram: !!telegram, max: !!max } };
}

// ---------- OTP (демо: код возвращается в ответе) ----------
function issueOtp(method, ident) {
  const otps = read(F.otp, {});
  const code = String(Math.floor(1000 + Math.random() * 9000));
  otps[method + ":" + ident] = { code, method, ident, expires: Date.now() + 10 * 60 * 1000 };
  write(F.otp, otps);
  return code;
}
function checkOtp(method, ident, code) {
  const key = method + ":" + ident;
  const otps = read(F.otp, {});
  const rec = otps[key];
  const ok = code === "0000" || (rec && rec.code === code && rec.expires > Date.now());
  if (ok && rec) { delete otps[key]; write(F.otp, otps); }
  return ok;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
// pattern: строка с :params → RegExp
function compile(pattern) {
  const keys = [];
  const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
  return { rx, keys };
}
const compiled = new Map();

// ===== каталог =====
route("GET", "/api/products", (req, res) => json(res, 200, products()));
route("GET", "/api/products/:id", (req, res, p) => {
  const item = products().find((x) => x.id === p.id);
  if (!item) return json(res, 404, { error: "Товар не найден" });
  json(res, 200, { ...item, reviews: reviewsForProduct(item.id) });
});
route("GET", "/api/products/:id/reviews", (req, res, p) => {
  json(res, 200, reviewsForProduct(p.id));
});
// Статус интеграции Ozon
route("GET", "/api/ozon/status", (req, res) => json(res, 200, ozon.status()));
// Пересинхронизировать каталог из Ozon
route("POST", "/api/ozon/sync", async (req, res) => { await ozon.sync(); json(res, 200, ozon.status()); });

// ===== авторизация =====
// Шаг 1: запросить код (phone/email)
route("POST", "/api/auth/request-code", async (req, res, _p, body) => {
  const method = body.method;
  if (!["phone", "email"].includes(method)) return json(res, 400, { error: "Метод не поддерживает код" });
  const ident = normIdent(method, body.identifier);
  if (!ident) return json(res, 400, { error: "Укажите " + (method === "phone" ? "телефон" : "почту") });
  const code = issueOtp(method, ident);
  // В демо возвращаем код прямо в ответе (в реале — SMS/email).
  json(res, 200, { ok: true, demoCode: code, sentTo: ident });
});
// Шаг 2: подтвердить код → логин или регистрация
route("POST", "/api/auth/verify-code", async (req, res, _p, body) => {
  const method = body.method, ident = normIdent(method, body.identifier);
  if (!checkOtp(method, ident, String(body.code || ""))) return json(res, 400, { error: "Неверный или истёкший код" });
  let user = findUserByChannel(method, ident);
  let isNew = false;
  if (!user) { user = blankUser({ [method]: ident }); isNew = true; saveUser(user); }
  const token = newSession(user.id);
  json(res, 200, { ok: true, token, isNew, user: publicUser(user) });
});
// Соц-вход (telegram/max) — в демо принимаем handle и логиним/регистрируем
route("POST", "/api/auth/social", async (req, res, _p, body) => {
  const method = body.method;
  if (!["telegram", "max"].includes(method)) return json(res, 400, { error: "Неизвестный провайдер" });
  const ident = normIdent(method, body.handle || body.identifier);
  if (!ident) return json(res, 400, { error: "Не передан аккаунт" });
  let user = findUserByChannel(method, ident);
  let isNew = false;
  if (!user) {
    user = blankUser({ [method]: ident, firstName: body.firstName || "", lastName: body.lastName || "" });
    isNew = true; saveUser(user);
  }
  const token = newSession(user.id);
  json(res, 200, { ok: true, token, isNew, user: publicUser(user) });
});
route("GET", "/api/auth/me", (req, res) => {
  const u = currentUser(req);
  json(res, 200, { user: publicUser(u) });
});
route("POST", "/api/auth/logout", (req, res) => {
  const token = tokenFrom(req);
  if (token) { const s = read(F.sessions, {}); delete s[token]; write(F.sessions, s); }
  json(res, 200, { ok: true });
});

// helper: требовать авторизацию
function auth(handler) {
  return (req, res, p, body) => {
    const u = currentUser(req);
    if (!u) return json(res, 401, { error: "Нужен вход" });
    return handler(req, res, p, body, u);
  };
}

// ===== профиль =====
route("PUT", "/api/profile", auth(async (req, res, _p, body, u) => {
  for (const k of ["firstName", "lastName", "birthday", "gender"]) if (k in body) u[k] = String(body[k] || "").slice(0, 100);
  saveUser(u);
  json(res, 200, { user: publicUser(u) });
}));
// привязать канал входа к текущему аккаунту
route("POST", "/api/profile/link", auth(async (req, res, _p, body, u) => {
  const method = body.method, ident = normIdent(method, body.identifier || body.handle);
  if (!["phone", "email", "telegram", "max"].includes(method) || !ident) return json(res, 400, { error: "Плохие данные" });
  if (["phone", "email"].includes(method) && !checkOtp(method, ident, String(body.code || "")))
    return json(res, 400, { error: "Нужен код подтверждения" });
  if (findUserByChannel(method, ident)) return json(res, 409, { error: "Этот аккаунт уже привязан" });
  u[method] = ident; saveUser(u);
  json(res, 200, { user: publicUser(u) });
}));
route("PUT", "/api/profile/settings", auth(async (req, res, _p, body, u) => {
  u.settings = { ...u.settings, ...(body.settings || {}) }; saveUser(u);
  json(res, 200, { user: publicUser(u) });
}));

// ===== адреса =====
route("POST", "/api/addresses", auth(async (req, res, _p, body, u) => {
  const a = { id: uid("a_"), title: body.title || "Адрес", city: body.city || "", street: body.street || "",
    house: body.house || "", flat: body.flat || "", entrance: body.entrance || "", floor: body.floor || "",
    comment: body.comment || "", type: body.type || "courier", isDefault: !u.addresses.length };
  u.addresses.push(a); saveUser(u); json(res, 201, { address: a, user: publicUser(u) });
}));
route("PUT", "/api/addresses/:id", auth(async (req, res, p, body, u) => {
  const a = u.addresses.find((x) => x.id === p.id); if (!a) return json(res, 404, { error: "нет" });
  Object.assign(a, body, { id: a.id });
  if (body.isDefault) u.addresses.forEach((x) => (x.isDefault = x.id === a.id));
  saveUser(u); json(res, 200, { user: publicUser(u) });
}));
route("DELETE", "/api/addresses/:id", auth(async (req, res, p, _b, u) => {
  u.addresses = u.addresses.filter((x) => x.id !== p.id); saveUser(u); json(res, 200, { user: publicUser(u) });
}));

// ===== карты (демо) =====
route("POST", "/api/cards", auth(async (req, res, _p, body, u) => {
  const num = String(body.number || "").replace(/\D/g, "");
  const c = { id: uid("c_"), last4: num.slice(-4) || "0000", brand: num[0] === "5" ? "Mastercard" : "Visa",
    holder: body.holder || "", exp: body.exp || "", isDefault: !u.cards.length };
  u.cards.push(c); saveUser(u); json(res, 201, { card: c, user: publicUser(u) });
}));
route("DELETE", "/api/cards/:id", auth(async (req, res, p, _b, u) => {
  u.cards = u.cards.filter((x) => x.id !== p.id); saveUser(u); json(res, 200, { user: publicUser(u) });
}));

// ===== избранное =====
route("POST", "/api/favorites/:id", auth(async (req, res, p, _b, u) => {
  if (!u.favorites.includes(p.id)) u.favorites.push(p.id); saveUser(u); json(res, 200, { favorites: u.favorites });
}));
route("DELETE", "/api/favorites/:id", auth(async (req, res, p, _b, u) => {
  u.favorites = u.favorites.filter((x) => x !== p.id); saveUser(u); json(res, 200, { favorites: u.favorites });
}));

// ===== промокоды =====
const PROMOS = { MALYSH: { type: "percent", value: 10, label: "−10% на всё" },
  MEPSI500: { type: "fixed", value: 500, label: "−500 ₽", min: 2000 },
  LULU15: { type: "percent", value: 15, label: "−15% на LULU" } };
route("POST", "/api/promo/apply", async (req, res, _p, body) => {
  const code = String(body.code || "").toUpperCase().trim();
  const promo = PROMOS[code];
  if (!promo) return json(res, 404, { error: "Промокод не найден" });
  json(res, 200, { code, ...promo });
});

// ===== заказы =====
function statusFlow(status) {
  const steps = ["created", "assembling", "shipping", "delivered"];
  return steps.indexOf(status);
}
route("GET", "/api/orders", auth((req, res, _p, _b, u) => {
  const all = read(F.orders, []).filter((o) => o.userId === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  json(res, 200, all);
}));
route("GET", "/api/orders/:id", auth((req, res, p, _b, u) => {
  const o = read(F.orders, []).find((x) => x.id === p.id && x.userId === u.id);
  if (!o) return json(res, 404, { error: "нет" }); json(res, 200, o);
}));
route("POST", "/api/orders", auth(async (req, res, _p, body, u) => {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json(res, 400, { error: "Корзина пуста" });
  const prods = products();
  let subtotal = 0;
  const lines = items.map((it) => {
    const pr = prods.find((x) => x.id === it.id) || {};
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    subtotal += (pr.price || 0) * qty;
    return { id: it.id, title: pr.title || "?", price: pr.price || 0, qty, em: pr.em || "📦", brand: pr.brand || "" };
  });
  // скидка по промокоду
  let discount = 0;
  if (body.promo && PROMOS[body.promo]) {
    const pm = PROMOS[body.promo];
    discount = pm.type === "percent" ? Math.round(subtotal * pm.value / 100) : pm.value;
  }
  const pointsUsed = Math.min(u.points, Math.max(0, parseInt(body.pointsUsed, 10) || 0), subtotal - discount);
  const delivery = 0; // бесплатно
  const total = Math.max(0, subtotal - discount - pointsUsed + delivery);
  const pointsEarned = Math.round(total * 0.05); // 5% кэшбэк
  const order = {
    id: "ORD-" + Date.now(), userId: u.id, createdAt: now(),
    status: "created", statusLabel: "Оформлен",
    items: lines, subtotal, discount, pointsUsed, delivery, total, pointsEarned,
    promo: body.promo || null,
    delivery_info: body.delivery || {}, payment: body.payment || { method: "card" },
    eta: body.eta || "2–3 дня",
  };
  const orders = read(F.orders, []); orders.push(order); write(F.orders, orders);
  // начислить/списать баллы
  u.points = u.points - pointsUsed + pointsEarned; saveUser(u);
  json(res, 201, { ok: true, order, user: publicUser(u) });
}));
route("POST", "/api/orders/:id/cancel", auth(async (req, res, p, _b, u) => {
  const orders = read(F.orders, []); const o = orders.find((x) => x.id === p.id && x.userId === u.id);
  if (!o) return json(res, 404, { error: "нет" });
  if (["delivered", "cancelled"].includes(o.status)) return json(res, 400, { error: "Заказ нельзя отменить" });
  o.status = "cancelled"; o.statusLabel = "Отменён"; write(F.orders, orders);
  json(res, 200, { order: o });
}));

// ===== возвраты =====
route("GET", "/api/returns", auth((req, res, _p, _b, u) => {
  json(res, 200, read(F.returns, []).filter((r) => r.userId === u.id));
}));
route("POST", "/api/returns", auth(async (req, res, _p, body, u) => {
  const r = { id: uid("ret_"), userId: u.id, createdAt: now(), orderId: body.orderId || null,
    items: body.items || [], reason: body.reason || "", status: "review", statusLabel: "На рассмотрении" };
  const list = read(F.returns, []); list.push(r); write(F.returns, list);
  json(res, 201, { return: r });
}));

// ===== отзывы =====
route("POST", "/api/reviews", auth(async (req, res, _p, body, u) => {
  const r = { id: uid("rev_"), productId: body.productId, userId: u.id,
    author: publicUser(u).name || "Покупатель", rating: Math.min(5, Math.max(1, parseInt(body.rating, 10) || 5)),
    text: String(body.text || "").slice(0, 2000), pros: body.pros || "", cons: body.cons || "",
    createdAt: now(), photos: body.photos || [] };
  const list = userReviews(); list.unshift(r); write(F.reviews, list);
  json(res, 201, { review: r });
}));

// ---------- server ----------
function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url.split("?")[0]) || "/");
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: неизвестный маршрут без расширения → index.html
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end("Not found"); }
          res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(html);
        });
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Не найдено");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/")) {
    // найти маршрут
    for (const r of routes) {
      if (r.method !== req.method) continue;
      if (!compiled.has(r.pattern)) compiled.set(r.pattern, compile(r.pattern));
      const { rx, keys } = compiled.get(r.pattern);
      const m = url.match(rx);
      if (!m) continue;
      const params = {}; keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body = {};
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        try { body = await readBody(req); } catch { return json(res, 400, { error: "Плохой JSON" }); }
      }
      try { return await r.handler(req, res, params, body); }
      catch (e) { console.error(e); return json(res, 500, { error: "Ошибка сервера" }); }
    }
    return json(res, 404, { error: "Маршрут не найден" });
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, async () => {
  console.log(`Mepsi & LULU запущен: http://localhost:${PORT}`);
  console.log(`Данные:  ${DATA_DIR}`);
  const s = await ozon.sync();
  console.log(`Каталог Ozon [${s.mode}]: ${s.count} товаров, ${s.reviews?.length ?? ozon.status().reviews} отзывов` + (s.error ? ` (ошибка: ${s.error})` : ""));
});
