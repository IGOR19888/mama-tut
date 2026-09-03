// Диагностика связи с Ozon Seller API. Запуск: node --env-file=.env scripts/ozon-test.js
// (или положи OZON_CLIENT_ID/OZON_API_KEY в .env — server.js их подхватит, но этот скрипт
//  проще запускать с --env-file). Ключи не печатаем.
const https = require("https");
const fs = require("fs");
const path = require("path");

// подхватить .env, если запущено без --env-file
try {
  const p = path.join(__dirname, "..", ".env");
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const CLIENT_ID = process.env.OZON_CLIENT_ID || "";
const API_KEY = process.env.OZON_API_KEY || "";
if (!CLIENT_ID || !API_KEY) { console.error("❌ Нет OZON_CLIENT_ID/OZON_API_KEY. Заполни .env (см. .env.example)."); process.exit(1); }
console.log(`Client-Id: ***${CLIENT_ID.slice(-3)}  Api-Key: ***${API_KEY.slice(-4)}\n`);

function call(pathname, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = https.request("https://api-seller.ozon.ru" + pathname, {
      method: "POST",
      headers: { "Client-Id": CLIENT_ID, "Api-Key": API_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.write(data); req.end();
  });
}
const short = (s, n = 800) => (s.length > n ? s.slice(0, n) + " …(обрезано)" : s);

(async () => {
  console.log("1) /v3/product/list (первые товары продавца)");
  const list = await call("/v3/product/list", { filter: { visibility: "ALL" }, limit: 5 });
  console.log("   HTTP", list.status);
  console.log("  ", short(list.body), "\n");
  let offerIds = [];
  try { offerIds = (JSON.parse(list.body).result.items || []).map((i) => i.offer_id).filter(Boolean); } catch {}
  console.log("   offer_id найдено:", offerIds.slice(0, 5), "\n");

  if (offerIds.length) {
    console.log("2) /v3/product/info/list (карточка первого товара)");
    const info = await call("/v3/product/info/list", { offer_id: offerIds.slice(0, 2) });
    console.log("   HTTP", info.status);
    console.log("  ", short(info.body, 1400), "\n");

    console.log("3) /v5/product/info/prices (цены)");
    const pr = await call("/v5/product/info/prices", { filter: { offer_id: offerIds.slice(0, 2), visibility: "ALL" }, limit: 5 });
    console.log("   HTTP", pr.status);
    console.log("  ", short(pr.body), "\n");

    console.log("4) /v4/product/info/attributes (характеристики, бренд)");
    const at = await call("/v4/product/info/attributes", { filter: { offer_id: offerIds.slice(0, 2), visibility: "ALL" }, limit: 5 });
    console.log("   HTTP", at.status);
    console.log("  ", short(at.body, 1400), "\n");
  }

  console.log("5) /v1/review/list (отзывы — требует подписку Premium Plus)");
  const rv = await call("/v1/review/list", { limit: 3, sort_dir: "DESC", status: "ALL" });
  console.log("   HTTP", rv.status);
  console.log("  ", short(rv.body), "\n");

  console.log("Готово. Пришли этот вывод — подгоню нормализатор под реальные поля твоего аккаунта.");
})();
