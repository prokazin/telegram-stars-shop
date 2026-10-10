// ============================================================
// Telegram Stars Shop — Cloudflare Worker
// Обрабатывает: вебхук бота, создание инвойсов Stars,
// автоматический заказ у поставщика, выдачу товара.
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org';

// ---------- Утилиты ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ---------- Работа с Telegram Bot API ----------

async function tgRequest(env, method, payload) {
  const url = `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ---------- Работа с API поставщика ----------

async function supplierGetCatalog(env) {
  const res = await fetch(`${env.SUPPLIER_API_URL}/catalog`, {
    headers: { 'Authorization': `Bearer ${env.SUPPLIER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Supplier catalog error: ${res.status}`);
  return res.json();
}

async function supplierCreateOrder(env, sku, telegramUserId) {
  const res = await fetch(`${env.SUPPLIER_API_URL}/order`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SUPPLIER_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `order-${sku}-${telegramUserId}-${Date.now()}`,
    },
    body: JSON.stringify({ sku, telegramUserId }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supplier order error: ${res.status} — ${err}`);
  }
  return res.json();
}

// ---------- Наценка ----------

function applyMarkup(basePrice, markupPercent) {
  const pct = parseFloat(markupPercent) || 0;
  return Math.ceil(basePrice * (1 + pct / 100));
}

// ============================================================
// Основной обработчик
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') return handleOptions();

    // ---------- API: Каталог товаров ----------
    if (url.pathname === '/api/catalog' && request.method === 'GET') {
      try {
        const catalog = await supplierGetCatalog(env);
        const items = (catalog.products || catalog.items || catalog).map((p) => ({
          id: p.id || p.sku,
          sku: p.sku || p.id,
          name: p.name || p.title,
          description: p.description || '',
          image: p.image || p.imageUrl || '',
          price: applyMarkup(p.price, env.SUPPLIER_MARKUP_PERCENT),
          supplierPrice: p.price,
        }));
        return json({ items });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- API: Создание инвойса Telegram Stars ----------
    if (url.pathname === '/api/create-invoice' && request.method === 'POST') {
      try {
        const { sku, name, price, telegramUserId } = await request.json();

        if (!sku || !name || !price || !telegramUserId) {
          return json({ error: 'Missing required fields' }, 400);
        }

        const invoiceLink = await tgRequest(env, 'createInvoiceLink', {
          title: name,
          description: `Покупка цифрового товара: ${name}`,
          payload: JSON.stringify({ sku, telegramUserId }),
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: name, amount: price }],
        });

        if (!invoiceLink.ok) {
          return json({ error: invoiceLink.description || 'Invoice creation failed' }, 500);
        }

        return json({ invoiceLink: invoiceLink.result });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---------- Вебхук Telegram ----------
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env));
      } catch (e) {
        // Игнорируем ошибки парсинга
      }
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ============================================================
// Обработка обновлений от Telegram
// ============================================================

async function handleTelegramUpdate(update, env) {
  // --- Pre-checkout ---
  if (update.pre_checkout_query) {
    await tgRequest(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok: true,
    });
    return;
  }

  // --- Успешная оплата ---
  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const chatId = update.message.chat.id;

    let payload;
    try {
      payload = JSON.parse(payment.invoice_payload);
    } catch {
      return;
    }

    const { sku, telegramUserId } = payload;

    try {
      // Заказываем товар у поставщика
      const order = await supplierCreateOrder(env, sku, telegramUserId);

      // Получаем товар из ответа поставщика
      const goods =
        order.code ||
        order.key ||
        order.codes?.[0] ||
        order.delivery ||
        JSON.stringify(order);

      // Отправляем товар покупателю
      await tgRequest(env, 'sendMessage', {
        chat_id: chatId,
        text: `✅ *Оплата прошла успешно!*\n\n🎁 *Ваш товар:*\n\`${goods}\`\n\nСпасибо за покупку!`,
        parse_mode: 'Markdown',
      });
    } catch (e) {
      // Если что-то пошло не так — уведомляем покупателя
      await tgRequest(env, 'sendMessage', {
        chat_id: chatId,
        text: `⚠️ Оплата прошла, но возникла задержка с выдачей товара. Мы уже работаем над этим. Ошибка: ${e.message}`,
      });
    }
    return;
  }

  // --- Команда /start ---
  if (update.message?.text === '/start') {
    const chatId = update.message.chat.id;
    await tgRequest(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Добро пожаловать в Digital Stars Shop! Откройте магазин:',
      reply_markup: {
        inline_keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: env.WEBAPP_URL } }]],
      },
    });
  }
}
