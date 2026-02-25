/* runner.js – Buy Box Geo Sampler orchestration */

const $ = s => document.getElementById(s);
const logEl = $('log');

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── State helpers ──────────────────────────────── */

function getRunstate() {
  return new Promise(r => chrome.storage.local.get(['bbgs_runstate'], d => r(d.bbgs_runstate)));
}
function setRunstate(rs) {
  return new Promise(r => chrome.storage.local.set({ bbgs_runstate: rs }, r));
}
function getResults() {
  return new Promise(r => chrome.storage.local.get(['bbgs_results'], d => r(d.bbgs_results || [])));
}
function appendResult(row) {
  return new Promise(r => {
    chrome.storage.local.get(['bbgs_results'], d => {
      const arr = d.bbgs_results || [];
      arr.push(row);
      chrome.storage.local.set({ bbgs_results: arr }, r);
    });
  });
}

/* ── UI updates ────────────────────────────────── */

function updateInfo(rs) {
  $('stState').textContent = rs.running ? (rs.stopRequested ? 'Stopping…' : 'Running') : 'Stopped';
  $('stProgress').textContent = `${rs.idx} / ${rs.queue.length}`;
  $('stDelay').textContent = rs.delaySec;
  $('stSeller').textContent = rs.sellerName;
  $('stTab').textContent = rs.workTabId ?? '—';
}

function renderResults(rows) {
  const last80 = rows.slice(-80).reverse();
  $('tbody').innerHTML = last80.map(r => {
    const cls = r.is_you_featured ? 'is-you' : 'not-you';
    const badge = r.status === 'OK' ? 'badge-ok' : (r.status === 'CAPTCHA' ? 'badge-err' : 'badge-warn');
    return `<tr class="${cls}">
      <td>${r.timestamp?.slice(11,19) || ''}</td>
      <td>${r.asin}</td><td>${r.zip}</td>
      <td><span class="badge ${badge}">${r.status}</span></td>
      <td>${r.featured_sold_by}</td>
      <td>${r.is_you_featured ? '✅' : '❌'}</td>
      <td>${r.notes}</td>
    </tr>`;
  }).join('');
}

/* ── Tab helpers ───────────────────────────────── */

function ensureWorkTab(rs) {
  return new Promise((resolve) => {
    if (rs.workTabId) {
      chrome.tabs.get(rs.workTabId, tab => {
        if (chrome.runtime.lastError || !tab) {
          createWorkTab(rs).then(resolve);
        } else {
          resolve(rs.workTabId);
        }
      });
    } else {
      createWorkTab(rs).then(resolve);
    }
  });
}

function createWorkTab(rs) {
  return new Promise(resolve => {
    chrome.tabs.create({ url: 'https://www.amazon.com', active: false }, tab => {
      rs.workTabId = tab.id;
      setRunstate(rs).then(() => resolve(tab.id));
    });
  });
}

function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      // wait for load
      function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1500); // small grace period
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      // timeout after 30s
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, status: 'ERROR', error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, status: 'ERROR', error: 'No response' });
      }
    });
  });
}

/* ── Main loop ─────────────────────────────────── */

let lastZip = null;

async function runLoop() {
  let rs = await getRunstate();
  if (!rs || !rs.running) { log('No active run.'); return; }

  log(`Starting run: ${rs.queue.length} jobs, delay=${rs.delaySec}s, mode=${rs.mode}`);
  updateInfo(rs);

  const tabId = await ensureWorkTab(rs);
  log(`Work tab: ${tabId}`);
  updateInfo(rs);

  // Wait for initial tab load
  await sleep(2000);

  while (rs.idx < rs.queue.length) {
    rs = await getRunstate();
    if (!rs || rs.stopRequested || !rs.running) {
      log('Stop requested. Halting.');
      rs.running = false;
      rs.stopRequested = false;
      await setRunstate(rs);
      updateInfo(rs);
      return;
    }

    const job = rs.queue[rs.idx];
    log(`Job ${rs.idx + 1}/${rs.queue.length}: ASIN=${job.asin} ZIP=${job.zip}`);
    updateInfo(rs);

    let result = {
      timestamp: new Date().toISOString(),
      asin: job.asin,
      zip: job.zip,
      status: 'OK',
      featured_sold_by: '',
      is_you_featured: false,
      notes: '',
      url: `https://www.amazon.com/dp/${job.asin}?th=1&psc=1`
    };

    // Step 1: Set ZIP if needed
    if (job.zip !== lastZip) {
      log(`  Setting ZIP to ${job.zip}…`);
      await navigateTab(tabId, 'https://www.amazon.com');
      await sleep(2000);

      const zipRes = await sendToTab(tabId, { type: 'BBGS_SET_ZIP', zip: job.zip });
      if (zipRes.ok) {
        lastZip = job.zip;
        log(`  ZIP set OK.`);
        await sleep(2000);
      } else {
        log(`  ZIP set FAILED: ${zipRes.error || zipRes.status}`);
        if (zipRes.status === 'CAPTCHA') {
          result.status = 'CAPTCHA';
          result.notes = 'CAPTCHA during ZIP change';
          await appendResult(result);
          renderResults(await getResults());
          rs.idx++;
          await setRunstate(rs);
          log(`  Sleeping ${rs.delaySec}s…`);
          await sleep(rs.delaySec * 1000);
          continue;
        }
        result.status = 'ZIP_SET_FAILED';
        result.notes = zipRes.error || 'ZIP set failed';
        // still try ASIN extraction
      }
    } else {
      log(`  ZIP ${job.zip} already set, skipping.`);
    }

    // Step 2: Navigate to ASIN
    log(`  Loading ASIN page…`);
    await navigateTab(tabId, result.url);
    await sleep(2000);

    // Step 3: Extract
    const extRes = await sendToTab(tabId, { type: 'BBGS_EXTRACT', sellerName: rs.sellerName });
    if (extRes.ok) {
      if (result.status === 'OK' || result.status === 'ZIP_SET_FAILED') {
        result.status = result.status === 'ZIP_SET_FAILED' ? 'ZIP_SET_FAILED' : extRes.status;
      }
      result.featured_sold_by = extRes.soldBy || '';
      result.is_you_featured = extRes.isYou || false;
      result.notes = (result.notes ? result.notes + '; ' : '') + (extRes.notes || '');
      log(`  Sold by: "${result.featured_sold_by}" | You: ${result.is_you_featured ? 'YES ✅' : 'NO ❌'}`);
    } else {
      if (extRes.status === 'CAPTCHA') {
        result.status = 'CAPTCHA';
        result.notes = (result.notes ? result.notes + '; ' : '') + 'CAPTCHA on ASIN page';
        log(`  CAPTCHA detected!`);
      } else {
        result.status = 'EXTRACT_FAILED';
        result.notes = (result.notes ? result.notes + '; ' : '') + (extRes.error || 'Extraction failed');
        log(`  Extract failed: ${extRes.error}`);
      }
    }

    await appendResult(result);
    renderResults(await getResults());

    rs.idx++;
    await setRunstate(rs);
    updateInfo(rs);

    if (rs.idx < rs.queue.length) {
      log(`  Sleeping ${rs.delaySec}s…`);
      await sleep(rs.delaySec * 1000);
    }
  }

  log('✅ Run complete!');
  rs = await getRunstate();
  rs.running = false;
  await setRunstate(rs);
  updateInfo(rs);
}

/* ── Buttons ───────────────────────────────────── */

$('btnStop').addEventListener('click', async () => {
  const rs = await getRunstate();
  if (rs) {
    rs.stopRequested = true;
    rs.running = false;
    await setRunstate(rs);
    log('Stop requested.');
    updateInfo(rs);
  }
});

$('btnExport').addEventListener('click', async () => {
  const rows = await getResults();
  if (!rows.length) return log('No results.');
  const headers = ['timestamp','asin','zip','status','featured_sold_by','is_you_featured','notes','url'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const d = new Date().toISOString().slice(0,10);
  chrome.downloads.download({ url, filename: `buybox-geo-sampler_${d}.csv`, saveAs: true });
});

$('btnAmazon').addEventListener('click', async () => {
  const rs = await getRunstate();
  if (rs?.workTabId) {
    chrome.tabs.update(rs.workTabId, { active: true });
  } else {
    chrome.tabs.create({ url: 'https://www.amazon.com' });
  }
});

/* ── Init ──────────────────────────────────────── */

(async () => {
  const rs = await getRunstate();
  if (rs) updateInfo(rs);
  renderResults(await getResults());

  if (rs?.running && !rs.stopRequested) {
    runLoop();
  } else {
    log('No active run. Start from the popup.');
  }
})();
