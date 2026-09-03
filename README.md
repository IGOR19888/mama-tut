# Магазин (Node.js, без зависимостей)

Статичный фронт + мини-сервер на чистом Node. Товары — в JSON, заказы сохраняются на диск.
Никаких `npm install` и `node_modules` — только файлы.

## Запуск локально

```bash
cd shop
node server.js
# открой http://localhost:3000
```

## Структура

```
shop/
  server.js            # сервер: раздаёт сайт, /api/products, /api/orders
  package.json         # start: node server.js
  data/
    products.json      # ТОВАРЫ — правь этот файл (id обязателен и уникален)
    orders.json        # заказы (создаётся автоматически)
  public/
    index.html         # весь магазин: каталог, корзина, оформление
```

## Как менять товары

Открой `data/products.json`, скопируй блок, поменяй `id`, `title`, `price` (рубли, целым числом),
`desc`, `emoji`. Цена считается на сервере по этому файлу — клиент подделать сумму не может.

---

## Деплой на Railway (без репозитория)

```bash
npm i -g @railway/cli     # 1. поставить CLI (один раз)
railway login             # 2. войти
cd shop
railway init              # 3. создать проект (выбери New Project)
railway up                # 4. залить ЭТУ папку напрямую
railway domain            # 5. выдать публичный домен
```

`railway up` отправляет локальные файлы как есть — git не нужен.
Railway сам увидит `package.json` и запустит `npm start`. Порт берётся из `process.env.PORT` (уже учтено).

### ВАЖНО: постоянное хранение заказов (Volume)

Диск контейнера на Railway **временный** — без тома заказы сотрутся при передеплое.
Чтобы заказы жили:

1. В дашборде Railway → сервис → **Variables** → добавь `DATA_DIR = /data`
2. → **Settings → Volumes → New Volume**, mount path: `/data`
3. Redeploy. Теперь `orders.json` пишется в постоянный том `/data`.

(Локально `DATA_DIR` не задан — заказы просто лягут в `shop/data/`.)

### Просмотр заказов

`GET /api/orders` отдаёт все заказы (JSON). **На проде обязательно защити этот маршрут**
(токен в заголовке / отдельный админ-пароль) — сейчас он открыт для простоты.

### (Опционально) заказ в Telegram

В `server.js` есть отметка `// notifyTelegram(order)`. Можно допилить отправку заказа
в свой Telegram через Bot API — тогда уведомления будут падать в чат. Скажи — добавлю.
