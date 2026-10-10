// ============================================================
// Digital Stars Shop — Frontend
// ============================================================

const API_BASE = window.location.origin; // Cloudflare Worker URL

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#1a1a2e');
  tg.setBackgroundColor('#1a1a2e');
}

// ---------- Получение ID пользователя ----------
function getTelegramUserId() {
  return tg?.initDataUnsafe?.user?.id || null;
}

// ---------- Toast ----------
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

// ---------- Загрузка каталога ----------
async function loadCatalog() {
  const loader = document.getElementById('loader');
  const catalogEl = document.getElementById('catalog');

  try {
    const res = await fetch(`${API_BASE}/api/catalog`);
    if (!res.ok) throw new Error('Не удалось загрузить каталог');

    const data = await res.json();
    const items = data.items || [];

    if (items.length === 0) {
      loader.innerHTML = '<p>Пока нет товаров 😔</p>';
      return;
    }

    catalogEl.innerHTML = items.map((item, i) => `
      <div class="card glass" style="animation-delay: ${i * 0.06}s">
        ${item.image
          ? `<img class="card-image" src="${escapeHtml(item.image)}" alt="" loading="lazy" />`
          : `<div class="card-image" style="display:flex;align-items:center;justify-content:center;font-size:24px;">🎁</div>`
        }
        <div class="card-info">
          <div class="card-name">${escapeHtml(item.name)}</div>
          ${item.description ? `<div class="card-desc">${escapeHtml(item.description)}</div>` : ''}
          <div class="card-price">
            <span class="star-icon">⭐</span> ${item.price}
          </div>
        </div>
        <button class="buy-btn" data-sku="${escapeHtml(item.sku)}" data-name="${escapeHtml(item.name)}" data-price="${item.price}">
          Купить
        </button>
      </div>
    `).join('');

    loader.classList.add('hidden');
    catalogEl.classList.remove('hidden');

    // Обработчики кнопок
    catalogEl.querySelectorAll('.buy-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleBuy(btn));
    });
  } catch (e) {
    loader.innerHTML = `<p>Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}

// ---------- Покупка ----------
async function handleBuy(btn) {
  const userId = getTelegramUserId();
  if (!userId) {
    showToast('Откройте приложение через Telegram', 'error');
    return;
  }

  const sku = btn.dataset.sku;
  const name = btn.dataset.name;
  const price = parseInt(btn.dataset.price, 10);

  btn.disabled = true;
  btn.textContent = '...';

  try {
    const res = await fetch(`${API_BASE}/api/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, name, price, telegramUserId: userId }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка создания счёта');

    // Открываем оплату Stars внутри Telegram
    tg.openInvoice(data.invoiceLink, (status) => {
      if (status === 'paid') {
        showToast('Оплата прошла! Товар придёт в чат.', 'success');
      } else if (status === 'failed') {
        showToast('Оплата не прошла', 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Купить';
    });
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Купить';
  }
}

// ---------- Экранирование ----------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Старт ----------
loadCatalog();
