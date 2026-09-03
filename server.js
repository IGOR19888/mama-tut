// Магазин — сервер на чистом Node.js (без зависимостей).
// Раздаёт сайт из /public, отдаёт товары и сохраняет заказы на диск.
// На Railway: слушает process.env.PORT, заказы пишет в Volume (process.env.DATA_DIR).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
// Товары лежат рядом с кодом (правишь вручную). Заказы — в постоянный диск (Volume).
const PRODUCTS_FILE = path.join(__dirname, "data", "products.json");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// Убедимся, что папка для заказов существует
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch { return fallback; }
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  // защита от выхода за пределы папки
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Не найдено"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // --- API ---
  if (req.url === "/api/products" && req.method === "GET") {
    return sendJSON(res, 200, readJSON(PRODUCTS_FILE, []));
  }

  if (req.url === "/api/orders" && req.method === "GET") {
    // Простой админ-просмотр заказов. На проде защити токеном (см. README).
    return sendJSON(res, 200, readJSON(ORDERS_FILE, []));
  }

  if (req.url === "/api/orders" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // защита от гигантских тел
    });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJSON(res, 400, { error: "Плохой JSON" }); }

      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!payload.name || !payload.phone || items.length === 0) {
        return sendJSON(res, 400, { error: "Заполни имя, телефон и добавь хотя бы один товар" });
      }

      const products = readJSON(PRODUCTS_FILE, []);
      // Считаем сумму на сервере по реальным ценам (не доверяем клиенту)
      let total = 0;
      const lines = items.map((it) => {
        const p = products.find((x) => x.id === it.id);
        const price = p ? p.price : 0;
        const qty = Math.max(1, parseInt(it.qty, 10) || 1);
        total += price * qty;
        return { id: it.id, title: p ? p.title : "?", price, qty };
      });

      const order = {
        id: "ORD-" + Date.now(),
        createdAt: new Date().toISOString(),
        name: String(payload.name).slice(0, 200),
        phone: String(payload.phone).slice(0, 50),
        address: String(payload.address || "").slice(0, 500),
        comment: String(payload.comment || "").slice(0, 1000),
        items: lines,
        total,
      };

      const orders = readJSON(ORDERS_FILE, []);
      orders.push(order);
      fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

      // TODO (по желанию): отправить заказ в Telegram — раскомментируй и вставь токен/чат в переменные окружения.
      // notifyTelegram(order);

      return sendJSON(res, 201, { ok: true, orderId: order.id, total });
    });
    return;
  }

  // --- статика ---
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Магазин запущен: http://localhost:${PORT}`);
  console.log(`Товары:  ${PRODUCTS_FILE}`);
  console.log(`Заказы:  ${ORDERS_FILE}`);
});
