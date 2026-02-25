/* content.js – Buy Box Mapper – injected on amazon.com */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isCaptcha() {
  return !!(
    document.querySelector('form[action="/errors/validateCaptcha"]') ||
    document.title.toLowerCase().includes('robot check') ||
    document.body?.innerText?.includes('Type the characters you see')
  );
}

/* ── ZIP Setting ───────────────────────────────── */

async function setZip(zip) {
  if (isCaptcha()) return { ok: false, status: 'CAPTCHA', error: 'CAPTCHA page detected' };

  try {
    const deliverTo = document.querySelector('#nav-global-location-popover-link')
      || document.querySelector('#glow-ingress-block')
      || document.querySelector('[data-nav-role="flyout_trigger"]');

    if (!deliverTo) return { ok: false, status: 'ZIP_SET_FAILED', error: 'Cannot find Deliver-to element' };

    deliverTo.click();
    await sleep(1500);

    const zipInput = document.querySelector('#GLUXZipUpdateInput')
      || document.querySelector('input[data-action="GLUXPostalInputAction"]');

    if (!zipInput) return { ok: false, status: 'ZIP_SET_FAILED', error: 'Cannot find ZIP input' };

    zipInput.value = '';
    zipInput.focus();
    for (const ch of zip) {
      zipInput.value += ch;
      zipInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    zipInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);

    const applyBtn = document.querySelector('#GLUXZipUpdate input[type="submit"]')
      || document.querySelector('#GLUXZipUpdate .a-button-input')
      || document.querySelector('[data-action="GLUXPostalUpdateAction"]');

    if (applyBtn) {
      applyBtn.click();
    } else {
      const anyBtn = document.querySelector('#GLUXZipUpdate .a-button');
      if (anyBtn) anyBtn.click();
    }
    await sleep(2000);

    const doneBtn = document.querySelector('.a-popover-footer .a-button-primary .a-button-input')
      || document.querySelector('#GLUXConfirmClose')
      || document.querySelector('.a-popover-footer button');

    if (doneBtn) {
      doneBtn.click();
      await sleep(1000);
    }

    const closeBtn = document.querySelector('.a-popover-close');
    if (closeBtn) {
      closeBtn.click();
      await sleep(500);
    }

    return { ok: true, status: 'OK' };
  } catch (e) {
    return { ok: false, status: 'ZIP_SET_FAILED', error: e.message };
  }
}

/* ── Seller + quantity extraction ──────────────── */

function extractQuantityAvailable() {
  const availabilityText = document.querySelector('#availability, #mir-layout-DELIVERY_BLOCK-slot-AVAILABILITY, #outOfStock')?.textContent || '';
  const availabilityMatch = availabilityText.match(/Only\s+(\d+)\s+left\s+in\s+stock/i);
  if (availabilityMatch) {
    return { qty: Number(availabilityMatch[1]), note: 'qty from availability text' };
  }

  const quantitySelect = document.querySelector('#quantity, select[name="quantity"]');
  if (quantitySelect?.options?.length) {
    const parsed = [...quantitySelect.options]
      .map((o) => {
        const raw = String(o.textContent || o.value || '').trim();
        const plusMatch = raw.match(/^(\d+)\+$/);
        if (plusMatch) {
          return { rank: Number(plusMatch[1]), display: `${plusMatch[1]}+` };
        }
        const numericMatch = raw.match(/^(\d+)$/);
        if (numericMatch) {
          return { rank: Number(numericMatch[1]), display: String(Number(numericMatch[1])) };
        }
        return null;
      })
      .filter(Boolean);

    if (parsed.length) {
      parsed.sort((a, b) => a.rank - b.rank);
      const highest = parsed[parsed.length - 1];
      return { qty: highest.display, note: 'qty from quantity selector' };
    }
  }

  return { qty: '', note: 'qty unavailable' };
}

function extractSeller(sellerName) {
  if (isCaptcha()) return { ok: false, status: 'CAPTCHA', error: 'CAPTCHA page detected' };

  let soldBy = '';
  let notes = '';

  const sellerLink = document.querySelector('#sellerProfileTriggerId');
  if (sellerLink) {
    soldBy = sellerLink.textContent.trim();
    notes = 'via #sellerProfileTriggerId';
  }

  if (!soldBy) {
    const merchantInfo = document.querySelector('#merchant-info');
    if (merchantInfo) {
      const text = merchantInfo.textContent.trim();
      const m = text.match(/(?:Sold|Shipped)\s+by\s+(.+?)(?:\s+and\s+|\s*\.|\s*$)/i);
      if (m) {
        soldBy = m[1].trim();
        notes = 'via #merchant-info parse';
      } else {
        soldBy = text;
        notes = 'via #merchant-info raw';
      }
    }
  }

  if (!soldBy) {
    const tabularBuybox = document.querySelector('#tabular-buybox');
    if (tabularBuybox) {
      const text = tabularBuybox.textContent;
      const m = text.match(/(?:Sold|sold)\s+by\s*[:\s]*(.+?)(?:\s+and\s+|\n|\r|$)/i);
      if (m) {
        soldBy = m[1].trim();
        notes = 'via tabular-buybox parse';
      }
    }
  }

  if (!soldBy) {
    const buyboxEl = document.querySelector('#buyBoxAccordion') || document.querySelector('#rightCol');
    if (buyboxEl) {
      const text = buyboxEl.textContent;
      const m = text.match(/(?:Sold|sold)\s+by\s*[:\s]*(.+?)(?:\s+and\s+|\n|\r|$)/i);
      if (m) {
        soldBy = m[1].trim();
        notes = 'via generic buybox parse';
      }
    }
  }

  const status = soldBy ? 'OK' : 'UNKNOWN';
  const isYou = soldBy ? soldBy.toLowerCase().includes(sellerName.toLowerCase()) : false;
  if (!soldBy) notes = 'Could not find seller info on page';

  const qty = extractQuantityAvailable();
  notes = `${notes}; ${qty.note}`;

  return { ok: true, status, soldBy, isYou, notes, qtyAvailable: qty.qty };
}

/* ── Message handler ───────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'BBGS_SET_ZIP') {
    setZip(msg.zip).then(sendResponse);
    return true;
  }
  if (msg.type === 'BBGS_EXTRACT') {
    const result = extractSeller(msg.sellerName);
    sendResponse(result);
    return false;
  }
  return false;
});
