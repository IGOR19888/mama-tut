// Интеграция с Ozon Seller API (https://api-seller.ozon.ru).
// Тянет реальный каталог продавца + цены + характеристики + отзывы, нормализует в нашу схему.
// Ключей нет → работает на демо-каталоге (data/ozon-demo.json). Ошибка live → фолбэк на демо.
//
// Ключи (секрет, только из окружения; НИКОГДА не коммитить): OZON_CLIENT_ID, OZON_API_KEY
const https = require("https");

// Аккаунты Ozon (по одному на бренд-магазин). Данные объединяются в один каталог.
const CABS = [];
if (process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY)
  CABS.push({ clientId: process.env.OZON_CLIENT_ID, apiKey: process.env.OZON_API_KEY, brand: "Mepsi" });
if (process.env.OZON_CLIENT_ID_LULU && process.env.OZON_API_KEY_LULU)
  CABS.push({ clientId: process.env.OZON_CLIENT_ID_LULU, apiKey: process.env.OZON_API_KEY_LULU, brand: "LULU" });
const MODE = CABS.length ? "live" : "demo";
const _offerCred = {}; // offer_id → аккаунт (для ленивой загрузки описания)

// ---------- низкоуровневый POST к Ozon (для конкретного аккаунта) ----------
function call(path, body, cred) {
  cred = cred || CABS[0] || {};
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request("https://api-seller.ozon.ru" + path, {
      method: "POST",
      headers: {
        "Client-Id": cred.clientId, "Api-Key": cred.apiKey,
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null; try { json = JSON.parse(buf); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || {});
        else reject(new Error(`Ozon ${path} → ${res.statusCode}: ${buf.slice(0, 200)}`));
      });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

// ---------- категория по названию (для фильтра-чипов) ----------
function inferCat(name = "") {
  const n = name.toLowerCase();
  if (/подгузник|трусик/.test(n)) return "Подгузники";
  if (/салфет/.test(n)) return "Салфетки";
  if (/пелён|пелен/.test(n)) return "Пелёнки";
  if (/стирк|порош|кондиционер для бель/.test(n)) return "Стирка";
  if (/посуд|уборк|чист/.test(n)) return "Бытовая химия";
  if (/шампун|пена|купан|мыло|гель для душ|гель для купан/.test(n)) return "Купание";
  if (/крем|масло|молочко|присыпк|паста|бальзам|уход/.test(n)) return "Уход";
  if (/бутылоч|соск|поильник|кормл/.test(n)) return "Кормление";
  if (/набор/.test(n)) return "Наборы";
  return "Товары";
}
const brandOf = (raw) => (/lulu|лулу/i.test(raw || "") ? "LULU" : "Mepsi");
const numify = (s) => +String(s ?? "").replace(/[^\d.]/g, "") || 0;

// ---------- нормализация DEMO (data/ozon-demo.json, форма близка к Ozon) ----------
const attrVal = (attrs, name) => (attrs || []).find((a) => a.name === name)?.value || "";
function normalizeDemo(o) {
  const attrs = o.attributes || [];
  const brand = brandOf(attrVal(attrs, "Бренд") || o.brand);
  const skip = new Set(["Бренд", "Тип", "Краткое описание"]);
  const specs = attrs.filter((a) => !skip.has(a.name) && a.value).map((a) => [a.name, String(a.value)]);
  const price = numify(o.price), old = numify(o.old_price);
  return {
    id: String(o.offer_id || o.sku), sku: o.sku, brand, cat: attrVal(attrs, "Тип") || "Товары",
    title: o.name || "", price, old: old > price ? old : undefined,
    rate: o.rating || 4.9, rev: o.reviews_count || 0,
    em: o.primary_image || "📦", gallery: (o.images?.length ? o.images : [o.primary_image || "📦"]),
    sub: attrVal(attrs, "Краткое описание") || "", desc: o.description || "", specs,
    seller: o.seller || (brand === "LULU" ? "LULU (официальный)" : "Mepsi"),
    stock: o.stocks?.present ?? 50, badge: o.badge || undefined,
  };
}
function normalizeDemoReview(r, productId) {
  return { id: r.id || "orev_" + Math.random().toString(36).slice(2, 9), productId,
    author: r.author || "Покупатель Ozon", rating: r.rating || 5, text: r.text || "",
    pros: r.pros || "", cons: r.cons || "", photos: r.photos || [], createdAt: r.published_at || new Date().toISOString() };
}
function demoRaw() { try { return require("./data/ozon-demo.json"); } catch { return []; } }

// ---------- LIVE: сбор из реальных ручек Ozon ----------
async function listAll(cred) {
  let items = [], last_id = "";
  for (let guard = 0; guard < 10; guard++) {
    const r = await call("/v3/product/list", { filter: { visibility: "ALL" }, limit: 1000, last_id }, cred);
    const res = r.result || {};
    const page = res.items || [];
    items = items.concat(page);
    last_id = res.last_id || "";
    if (!page.length || !last_id) break;
  }
  return items;
}
async function chunked(offerIds, size, fn) {
  const out = [];
  for (let i = 0; i < offerIds.length; i += size) out.push(...(await fn(offerIds.slice(i, i + size))));
  return out;
}
// параллельная обработка с ограничением одновременных запросов
async function mapLimit(arr, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const idx = i++; await fn(arr[idx]); }
  });
  await Promise.all(workers);
}
async function reviewsAll(cred) {
  let out = [], last_id = "";
  try {
    for (let guard = 0; guard < 30; guard++) {
      const r = await call("/v1/review/list", { limit: 100, sort_dir: "DESC", status: "ALL", last_id }, cred);
      const revs = r.reviews || [];
      out.push(...revs);
      last_id = r.last_id || "";
      if (!r.has_next || !revs.length) break;
    }
  } catch (e) { /* нет доступа к отзывам — не критично */ }
  return out;
}
function normalizeLive(inf, at, revs, dict, brandForce) {
  const attrs = at?.attributes || [];
  const brandRaw = attrs.find((a) => a.id === 85)?.values?.[0]?.value || "";
  const brand = brandForce || brandOf(brandRaw);
  const rawImages = (inf.images && inf.images.length ? inf.images : at?.images) || [];
  // главное (брендовое) фото — как показывает витрина Ozon — ставим первым
  const primary = at?.primary_image || rawImages[0];
  const images = primary ? [primary, ...rawImages.filter((i) => i !== primary)] : rawImages;
  const price = numify(inf.price), old = numify(inf.old_price);
  const rev = revs.length;
  const rate = rev ? +(revs.reduce((s, r) => s + (r.rating || 5), 0) / rev).toFixed(1) : 4.9;
  const RU = { g: "г", kg: "кг", mg: "мг", mm: "мм", cm: "см", m: "м" };
  const u = (x) => RU[x] || x;
  // характеристики: маппим атрибуты Ozon (числовые id) в читаемые названия по словарю
  const NAME = dict || {};
  const SKIP = /хештег|аннотац|pdf|видео|rich|json|^код |артикул|маркиров|оптом|^название|gtin|штрих|цена|ндс|вес с упаковкой|ключев|объедин|похожие товары|модельн|партномер|поставщик/i;
  const seen = new Set(["Бренд"]);
  const specs = [["Бренд", brand]];
  for (const a of attrs) {
    const name = NAME[a.id];
    if (!name || seen.has(name) || SKIP.test(name) || name.startsWith("#")) continue;
    const value = (a.values || []).map((v) => v.value).filter(Boolean).join(", ");
    if (!value || value.length > 140) continue;
    seen.add(name); specs.push([name, value]);
  }
  if (at?.weight && !seen.has("Вес")) specs.push(["Вес", `${at.weight} ${u(at.weight_unit) || "г"}`]);
  if (at?.height && at?.width && at?.depth && !seen.has("Габариты")) specs.push(["Габариты", `${at.height}×${at.width}×${at.depth} ${u(at.dimension_unit) || "мм"}`]);
  if (at?.barcode && !seen.has("Штрихкод")) specs.push(["Штрихкод", String(at.barcode)]);
  return {
    id: inf.offer_id, sku: inf.sources?.[0]?.sku || inf.id, brand, cat: inferCat(inf.name),
    title: inf.name || "", price, old: old > price ? old : undefined,
    rate, rev, em: at?.primary_image || images[0] || "📦",
    gallery: images.length ? images : [at?.primary_image || "📦"],
    sub: "", desc: "", specs: specs.slice(0, 16), seller: brand === "LULU" ? "LULU (Ozon)" : "Mepsi (Ozon)",
    stock: inf.has_fbo_stocks || inf.has_fbs_stocks ? 50 : 0,
    badge: rev >= 100 ? "хит" : undefined,
  };
}
// словарь атрибутов категории: id → читаемое название
async function fetchDict(cred, catId, typeId) {
  const r = await call("/v1/description-category/attribute", { description_category_id: catId, type_id: typeId, language: "DEFAULT" }, cred);
  const arr = r.result || r.attributes || [];
  const map = {}; for (const a of arr) map[a.id] = a.name;
  return map;
}
async function buildCabinet(cred) {
  const listItems = await listAll(cred);
  const offerIds = listItems.map((i) => i.offer_id).filter(Boolean);
  if (!offerIds.length) return { products: [], reviews: [] };
  const skuToOffer = {};
  for (const it of listItems) if (it.sku) skuToOffer[it.sku] = it.offer_id;

  const infos = await chunked(offerIds, 100, async (ids) => {
    const r = await call("/v3/product/info/list", { offer_id: ids }, cred);
    return r.items || r.result?.items || [];
  });
  for (const inf of infos) for (const s of inf.sources || []) if (s.sku) skuToOffer[s.sku] = inf.offer_id;

  const attrs = await chunked(offerIds, 100, async (ids) => {
    const r = await call("/v4/product/info/attributes", { filter: { offer_id: ids, visibility: "ALL" }, limit: 1000 }, cred);
    return r.result || r.items || [];
  });
  const attrByOffer = Object.fromEntries(attrs.map((a) => [a.offer_id, a]));

  const rawReviews = await reviewsAll(cred);
  const revByOffer = {};
  for (const rv of rawReviews) {
    const off = skuToOffer[rv.sku];
    if (!off) continue;
    (revByOffer[off] = revByOffer[off] || []).push(rv);
  }

  // реальные фото/видео отзывов — /v1/review/info по отзывам с медиа (с ограничением)
  const mediaRevs = rawReviews.filter((rv) => (rv.photos_amount || 0) > 0 || (rv.videos_amount || 0) > 0).slice(0, 150);
  const mediaMap = {};
  await mapLimit(mediaRevs, 8, async (rv) => {
    try {
      const inf = await call("/v1/review/info", { review_id: rv.id }, cred);
      mediaMap[rv.id] = {
        photos: (inf.photos || []).map((p) => p.url).filter(Boolean),
        videos: (inf.videos || []).map((v) => v.url || v.link || v.preview_url).filter(Boolean),
      };
    } catch {}
  });

  // словари атрибутов по уникальным (категория, тип) — для полных характеристик
  const pairs = [...new Set(infos.map((i) => i.description_category_id + "_" + i.type_id))];
  const dicts = {};
  for (const pr of pairs) { const [c, t] = pr.split("_"); try { dicts[pr] = await fetchDict(cred, +c, +t); } catch { dicts[pr] = {}; } }

  const products = infos.map((inf) => {
    _offerCred[inf.offer_id] = cred;
    return normalizeLive(inf, attrByOffer[inf.offer_id], revByOffer[inf.offer_id] || [], dicts[inf.description_category_id + "_" + inf.type_id] || {}, cred.brand);
  });
  const reviews = [];
  for (const [off, list] of Object.entries(revByOffer))
    for (const rv of list) {
      const m = mediaMap[rv.id] || { photos: [], videos: [] };
      if ((rv.text && rv.text.trim()) || m.photos.length || m.videos.length)
        reviews.push({ id: rv.id, productId: off, author: `Покупатель ${cred.brand}`, rating: rv.rating || 5,
          text: rv.text || "", pros: "", cons: "", photos: m.photos, videos: m.videos, createdAt: rv.published_at });
    }
  return { products, reviews };
}
// собрать все аккаунты в один каталог
async function buildLive() {
  const all = { products: [], reviews: [] };
  for (const cred of CABS) {
    try { const r = await buildCabinet(cred); all.products.push(...r.products); all.reviews.push(...r.reviews); }
    catch (e) { console.error(`Ozon [${cred.brand}] ошибка:`, e.message); }
  }
  return all;
}

// ---------- описания (лениво, только live; демо — из карточки) ----------
const _descCache = {};
async function getDescription(offerId) {
  if (offerId in _descCache) return _descCache[offerId];
  if (MODE !== "live") { const p = (_cache?.products || []).find((x) => x.id === offerId); return (_descCache[offerId] = p?.desc || ""); }
  try { const r = await call("/v1/product/info/description", { offer_id: offerId }, _offerCred[offerId]); _descCache[offerId] = r?.result?.description || ""; }
  catch { _descCache[offerId] = ""; }
  return _descCache[offerId];
}

// ---------- сборка + кэш ----------
let _cache = null;
async function build() {
  if (MODE === "demo") {
    const raw = demoRaw();
    return { mode: "demo", products: raw.map(normalizeDemo),
      reviews: raw.flatMap((o) => (o.reviews || []).map((r) => normalizeDemoReview(r, String(o.offer_id)))),
      syncedAt: new Date().toISOString(), error: null };
  }
  const { products, reviews } = await buildLive();
  return { mode: "live", products, reviews, syncedAt: new Date().toISOString(), error: null };
}
async function sync() {
  try { _cache = await build(); if (_cache.mode === "live" && !_cache.products.length) throw new Error("live: пустой каталог"); }
  catch (e) {
    const raw = demoRaw();
    _cache = { mode: MODE === "live" ? "live-fallback" : "demo", products: raw.map(normalizeDemo),
      reviews: raw.flatMap((o) => (o.reviews || []).map((r) => normalizeDemoReview(r, String(o.offer_id)))),
      syncedAt: new Date().toISOString(), error: e.message };
    console.error("Ozon sync error:", e.message);
  }
  return _cache;
}
async function getCache() { return _cache || (await sync()); }
const products = () => (_cache ? _cache.products : demoRaw().map(normalizeDemo));
const reviewsFor = (productId) => (_cache ? _cache.reviews.filter((r) => r.productId === productId) : []);
const status = () => ({
  mode: _cache?.mode || MODE, hasKeys: MODE === "live",
  count: _cache?.products?.length ?? 0, reviews: _cache?.reviews?.length ?? 0,
  syncedAt: _cache?.syncedAt || null, error: _cache?.error || null,
});

module.exports = { MODE, sync, getCache, products, reviewsFor, getDescription, status };
