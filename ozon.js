// Интеграция с Ozon Seller API (https://api-seller.ozon.ru).
// Тянет реальный каталог продавца (оба бренда) + цены + характеристики + отзывы,
// нормализует в нашу схему товаров. Ключей нет → работает на демо-каталоге (data/ozon-demo.json).
//
// Ключи (секрет, только из окружения; НИКОГДА не коммитить):
//   OZON_CLIENT_ID, OZON_API_KEY
const https = require("https");

const BASE = "https://api-seller.ozon.ru";
const CLIENT_ID = process.env.OZON_CLIENT_ID || "";
const API_KEY = process.env.OZON_API_KEY || "";
const MODE = CLIENT_ID && API_KEY ? "live" : "demo";

// ---------- низкоуровневый POST к Ozon ----------
function call(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request(
      BASE + path,
      {
        method: "POST",
        headers: {
          "Client-Id": CLIENT_ID,
          "Api-Key": API_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || {});
          else reject(new Error(`Ozon ${path} → ${res.statusCode}: ${buf.slice(0, 300)}`));
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------- нормализация Ozon → наша схема ----------
const attr = (attrs, name) => (attrs || []).find((a) => a.name === name)?.value || "";
function normalize(o) {
  const attrs = o.attributes || [];
  const brandRaw = attr(attrs, "Бренд") || o.brand || "";
  const brand = /lulu/i.test(brandRaw) ? "LULU" : /mepsi|мепси/i.test(brandRaw) ? "Mepsi" : (brandRaw || "Mepsi");
  const skip = new Set(["Бренд", "Тип", "Краткое описание"]);
  const specs = attrs.filter((a) => !skip.has(a.name) && a.value).map((a) => [a.name, String(a.value)]);
  const price = +String(o.price || "").replace(/\s/g, "") || 0;
  const old = +String(o.old_price || "").replace(/\s/g, "") || 0;
  return {
    id: String(o.offer_id || o.sku || o.id),
    sku: o.sku,
    brand,
    cat: attr(attrs, "Тип") || "Товары",
    title: o.name || "",
    price,
    old: old && old > price ? old : undefined,
    rate: o.rating || 4.9,
    rev: o.reviews_count || 0,
    em: o.primary_image || "📦",
    gallery: (o.images && o.images.length ? o.images : [o.primary_image || "📦"]),
    sub: attr(attrs, "Краткое описание") || "",
    desc: o.description || "",
    specs,
    seller: o.seller || (brand === "LULU" ? "LULU (официальный)" : "Mepsi"),
    stock: o.stocks?.present ?? 50,
    badge: o.badge || undefined,
  };
}
function normalizeReview(r, productId) {
  return {
    id: r.id || "orev_" + Math.random().toString(36).slice(2, 9),
    productId,
    author: r.author || r.author_name || "Покупатель Ozon",
    rating: r.rating || 5,
    text: r.text || r.comment || "",
    pros: r.pros || "",
    cons: r.cons || "",
    photos: r.photos || [],
    createdAt: r.published_at || r.createdAt || new Date().toISOString(),
  };
}

// ---------- источник: live (Ozon) или demo ----------
let _cache = null; // { products:[], reviews:[], mode, count, syncedAt, error }

// DEMO: читаем сгенерированный каталог в форме Ozon и прогоняем через тот же нормализатор
function demoRaw() {
  try { return require("./data/ozon-demo.json"); } catch { return []; }
}

// LIVE: собираем каталог из реальных ручек Ozon Seller API
async function liveRaw() {
  // 1) список товаров продавца
  const list = await call("/v3/product/list", { filter: { visibility: "ALL" }, limit: 1000 });
  const items = list?.result?.items || [];
  const offerIds = items.map((i) => i.offer_id).filter(Boolean);
  if (!offerIds.length) return [];

  // 2) базовая инфа + 3) цены + 4) характеристики (батчами)
  const info = await call("/v3/product/info/list", { offer_id: offerIds });
  const infoItems = info?.items || info?.result?.items || [];

  let prices = [];
  try {
    const pr = await call("/v5/product/info/prices", { filter: { offer_id: offerIds, visibility: "ALL" }, limit: 1000 });
    prices = pr?.items || pr?.result?.items || [];
  } catch (e) { /* цены опциональны */ }
  const priceByOffer = {};
  for (const p of prices) priceByOffer[p.offer_id] = p.price || p;

  let attributes = [];
  try {
    const at = await call("/v4/product/info/attributes", { filter: { offer_id: offerIds, visibility: "ALL" }, limit: 1000 });
    attributes = at?.result || at?.items || [];
  } catch (e) { /* атрибуты опциональны */ }
  const attrByOffer = {};
  for (const a of attributes) attrByOffer[a.offer_id] = a;

  // 5) собрать «Ozon-объект» на каждый товар в форме, понятной normalize()
  return infoItems.map((it) => {
    const price = priceByOffer[it.offer_id] || {};
    const at = attrByOffer[it.offer_id] || {};
    const attrs = (at.attributes || []).map((a) => ({
      name: a.attribute_id, // будет заменено словарём ниже при необходимости
      value: (a.values || []).map((v) => v.value).join(", "),
    }));
    return {
      offer_id: it.offer_id,
      sku: it.sku || (it.sources && it.sources[0]?.sku),
      name: it.name,
      price: price.price || price.marketing_price || "",
      old_price: price.old_price || "",
      primary_image: it.primary_image || (it.images && it.images[0]) || "📦",
      images: it.images || [],
      description: at.description || "",
      attributes: attrs.length ? attrs : [{ name: "Бренд", value: at.brand || "" }],
      rating: it.rating,
      reviews_count: 0,
      stocks: { present: it.stocks?.present ?? it.fbo_stocks ?? 50 },
      seller: "",
    };
  });
}

// LIVE отзывы (best-effort; требует подписки Premium Plus, иначе пропускаем)
async function liveReviews() {
  try {
    const r = await call("/v1/review/list", { limit: 100, sort_dir: "DESC", status: "ALL" });
    const revs = r?.reviews || r?.result || [];
    return revs.map((rv) => normalizeReview(rv, String(rv.sku || rv.product_sku || rv.offer_id)));
  } catch (e) {
    return []; // нет доступа к API отзывов — не критично
  }
}

async function build() {
  if (MODE === "demo") {
    const raw = demoRaw();
    const products = raw.map(normalize);
    const reviews = raw.flatMap((o) => (o.reviews || []).map((r) => normalizeReview(r, String(o.offer_id))));
    return { mode: "demo", products, reviews, count: products.length, syncedAt: new Date().toISOString(), error: null };
  }
  // live
  const raw = await liveRaw();
  const products = raw.map(normalize);
  let reviews = await liveReviews();
  // если Ozon-отзывы недоступны — оставляем пусто (пользовательские отзывы всё равно работают)
  return { mode: "live", products, reviews, count: products.length, syncedAt: new Date().toISOString(), error: null };
}

// публичное API модуля
async function sync() {
  try { _cache = await build(); }
  catch (e) {
    // при ошибке live — не роняем магазин, откатываемся на демо
    const raw = demoRaw();
    _cache = { mode: MODE === "live" ? "live-fallback" : "demo", products: raw.map(normalize),
      reviews: raw.flatMap((o) => (o.reviews || []).map((r) => normalizeReview(r, String(o.offer_id)))),
      count: raw.length, syncedAt: new Date().toISOString(), error: e.message };
    console.error("Ozon sync error:", e.message);
  }
  return _cache;
}
async function getCache() { return _cache || (await sync()); }
const products = () => (_cache ? _cache.products : demoRaw().map(normalize));
const reviewsFor = (productId) => (_cache ? _cache.reviews.filter((r) => r.productId === productId) : []);
const status = () => ({
  mode: _cache?.mode || MODE,
  hasKeys: MODE === "live",
  count: _cache?.count ?? 0,
  reviews: _cache?.reviews?.length ?? 0,
  syncedAt: _cache?.syncedAt || null,
  error: _cache?.error || null,
});

module.exports = { MODE, sync, getCache, products, reviewsFor, status, normalize };
