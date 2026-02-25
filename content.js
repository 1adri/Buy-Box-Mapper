/* content.js – Buy Box Geo Sampler – injected on amazon.com */

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
    // Step 1: Click the "Deliver to" element to open the popover
    const deliverTo = document.querySelector('#nav-global-location-popover-link')
      || document.querySelector('#glow-ingress-block')
      || document.querySelector('[data-nav-role="flyout_trigger"]');

    if (!deliverTo) return { ok: false, status: 'ZIP_SET_FAILED', error: 'Cannot find Deliver-to element' };

    deliverTo.click();
    await sleep(1500);

    // Step 2: Find the ZIP input in the popover
    const zipInput = document.querySelector('#GLUXZipUpdateInput')
      || document.querySelector('input[data-action="GLUXPostalInputAction"]');

    if (!zipInput) return { ok: false, status: 'ZIP_SET_FAILED', error: 'Cannot find ZIP input' };

    // Clear and type the ZIP
    zipInput.value = '';
    zipInput.focus();
    // Simulate typing
    for (const ch of zip) {
      zipInput.value += ch;
      zipInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    zipInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);

    // Step 3: Click "Apply" / "Update"
    const applyBtn = document.querySelector('#GLUXZipUpdate input[type="submit"]')
      || document.querySelector('#GLUXZipUpdate .a-button-input')
      || document.querySelector('[data-action="GLUXPostalUpdateAction"]');

    if (applyBtn) {
      applyBtn.click();
    } else {
      // Try looking for any button in the zip section
      const anyBtn = document.querySelector('#GLUXZipUpdate .a-button');
      if (anyBtn) anyBtn.click();
    }
    await sleep(2000);

    // Step 4: Click "Done" or close
    const doneBtn = document.querySelector('.a-popover-footer .a-button-primary .a-button-input')
      || document.querySelector('#GLUXConfirmClose')
      || document.querySelector('.a-popover-footer button');

    if (doneBtn) {
      doneBtn.click();
      await sleep(1000);
    }

    // Also try pressing the close button on any remaining popover
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

/* ── Seller Extraction ─────────────────────────── */

function extractSeller(sellerName) {
  if (isCaptcha()) return { ok: false, status: 'CAPTCHA', error: 'CAPTCHA page detected' };

  let soldBy = '';
  let notes = '';

  // Method 1: #sellerProfileTriggerId
  const sellerLink = document.querySelector('#sellerProfileTriggerId');
  if (sellerLink) {
    soldBy = sellerLink.textContent.trim();
    notes = 'via #sellerProfileTriggerId';
  }

  // Method 2: #merchant-info
  if (!soldBy) {
    const merchantInfo = document.querySelector('#merchant-info');
    if (merchantInfo) {
      const text = merchantInfo.textContent.trim();
      // Parse "Sold by X and Fulfilled by Amazon"
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

  // Method 3: buybox area "Ships from and sold by"
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

  // Method 4: Generic "Sold by" search
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
  const isYou = soldBy
    ? soldBy.toLowerCase().includes(sellerName.toLowerCase())
    : false;

  if (!soldBy) notes = 'Could not find seller info on page';

  return { ok: true, status, soldBy, isYou, notes };
}

/* ── Message handler ───────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'BBGS_SET_ZIP') {
    setZip(msg.zip).then(sendResponse);
    return true; // async
  }
  if (msg.type === 'BBGS_EXTRACT') {
    const result = extractSeller(msg.sellerName);
    sendResponse(result);
    return false;
  }
});
