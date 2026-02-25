/* runner.js – Buy Box Mapper orchestration */

const $ = s => document.getElementById(s);
const logEl = $('log');

const filters = {
  search: '',
  status: 'all',
  you: 'all'
};

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
  $('stRetries').textContent = rs.maxRetries ?? 0;
  $('stSeller').textContent = rs.sellerName;
  $('stTab').textContent = rs.workTabId ?? '—';
}

function statusBadgeClass(status) {
  if (status === 'OK') return 'badge-ok';
  if (status === 'CAPTCHA' || status === 'ERROR') return 'badge-err';
  return 'badge-warn';
}

function applyFilters(rows) {
  return rows.filter(r => {
    if (filters.status !== 'all' && r.status !== filters.status) return false;
    if (filters.you === 'yes' && !r.is_you_featured) return false;
    if (filters.you === 'no' && r.is_you_featured) return false;

    if (!filters.search) return true;
    const haystack = [r.asin, r.zip, r.status, r.featured_sold_by, r.notes, r.featured_qty_available]
      .map(x => String(x ?? '').toLowerCase())
      .join(' ');
    return haystack.includes(filters.search.toLowerCase());
  });
}

function buildRateList(rows, field, maxItems = 5) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field] || '—';
    if (!map.has(key)) map.set(key, { total: 0, wins: 0 });
    const v = map.get(key);
    v.total += 1;
    if (row.is_you_featured) v.wins += 1;
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v, rate: v.total ? (v.wins / v.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, maxItems);
}

function renderSummary(rows) {
  const total = rows.length;
  const wins = rows.filter(r => r.is_you_featured).length;
  const fail = rows.filter(r => ['CAPTCHA', 'ZIP_SET_FAILED', 'EXTRACT_FAILED', 'ERROR'].includes(r.status)).length;
  const withQty = rows.filter(r => r.featured_qty_available !== '' && r.featured_qty_available != null).length;
  const avgRetries = total ? (rows.reduce((n, r) => n + (Number(r.retry_count) || 0), 0) / total).toFixed(2) : '0.00';

  $('summaryCards').innerHTML = [
    ['Total checks', total],
    ['Your wins', wins],
    ['Win rate', `${total ? ((wins / total) * 100).toFixed(1) : 0}%`],
    ['Failures', fail],
    ['Rows w/ qty', withQty],
    ['Avg retries', avgRetries]
  ].map(([label, value]) => `<div class="summary-card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const asinRates = buildRateList(rows, 'asin');
  $('summaryAsin').innerHTML = asinRates.length
    ? asinRates.map(r => `<li>${r.key}: ${r.wins}/${r.total} (${r.rate.toFixed(1)}%)</li>`).join('')
    : '<li>No data yet.</li>';

  const zipRates = buildRateList(rows, 'zip');
  $('summaryZip').innerHTML = zipRates.length
    ? zipRates.map(r => `<li>${r.key}: ${r.wins}/${r.total} (${r.rate.toFixed(1)}%)</li>`).join('')
    : '<li>No data yet.</li>';
}

function renderResults(rows) {
  const filtered = applyFilters(rows);
  const recent = filtered.slice(-200).reverse();

  $('tbody').innerHTML = recent.map(r => {
    const cls = r.is_you_featured ? 'is-you' : 'not-you';
    return `<tr class="${cls}">
      <td>${r.timestamp?.slice(11,19) || ''}</td>
      <td>${r.asin}</td>
      <td>${r.zip}</td>
      <td><span class="badge ${statusBadgeClass(r.status)}">${r.status}</span></td>
      <td>${r.featured_sold_by || ''}</td>
      <td>${r.is_you_featured ? '✅' : '❌'}</td>
      <td>${r.featured_qty_available ?? ''}</td>
      <td>${r.retry_count ?? 0}</td>
      <td>${r.notes || ''}</td>
    </tr>`;
  }).join('');

  renderSummary(rows);
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
      function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1500);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
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

async function runAttempt(job, rs, tabId, attemptNum) {
  let result = {
    run_id: rs.runId || '',
    timestamp: new Date().toISOString(),
    asin: job.asin,
    zip: job.zip,
    status: 'OK',
    featured_sold_by: '',
    is_you_featured: false,
    featured_qty_available: '',
    retry_count: attemptNum - 1,
    mode: rs.mode,
    delay_sec: rs.delaySec,
    notes: '',
    url: `https://www.amazon.com/dp/${job.asin}?th=1&psc=1`
  };

  if (job.zip !== lastZip) {
    log(`  Setting ZIP to ${job.zip}…`);
    await navigateTab(tabId, 'https://www.amazon.com');
    await sleep(2000);

    const zipRes = await sendToTab(tabId, { type: 'BBGS_SET_ZIP', zip: job.zip });
    if (zipRes.ok) {
      lastZip = job.zip;
      log('  ZIP set OK.');
      await sleep(1500);
    } else {
      result.status = zipRes.status || 'ZIP_SET_FAILED';
      result.notes = zipRes.error || 'ZIP set failed';
      if (zipRes.status === 'CAPTCHA') return result;
    }
  }

  log('  Loading ASIN page…');
  await navigateTab(tabId, result.url);
  await sleep(1500);

  const extRes = await sendToTab(tabId, { type: 'BBGS_EXTRACT', sellerName: rs.sellerName });
  if (extRes.ok) {
    if (result.status === 'OK') result.status = extRes.status;
    result.featured_sold_by = extRes.soldBy || '';
    result.is_you_featured = extRes.isYou || false;
    result.featured_qty_available = extRes.qtyAvailable ?? '';
    result.notes = (result.notes ? `${result.notes}; ` : '') + (extRes.notes || '');
  } else {
    result.status = extRes.status === 'CAPTCHA' ? 'CAPTCHA' : 'EXTRACT_FAILED';
    result.notes = (result.notes ? `${result.notes}; ` : '') + (extRes.error || 'Extraction failed');
  }

  return result;
}

function shouldRetry(status) {
  return ['ZIP_SET_FAILED', 'EXTRACT_FAILED', 'UNKNOWN', 'ERROR'].includes(status);
}

async function runLoop() {
  let rs = await getRunstate();
  if (!rs || !rs.running) { log('No active run.'); return; }

  log(`Starting run: ${rs.queue.length} jobs, delay=${rs.delaySec}s, mode=${rs.mode}, retries=${rs.maxRetries || 0}`);
  updateInfo(rs);

  const tabId = await ensureWorkTab(rs);
  log(`Work tab: ${tabId}`);
  updateInfo(rs);

  await sleep(1500);

  while (rs.idx < rs.queue.length) {
    rs = await getRunstate();
    if (!rs || rs.stopRequested || !rs.running) {
      log('Stop requested. Halting.');
      if (rs) {
        rs.running = false;
        rs.stopRequested = false;
        await setRunstate(rs);
        updateInfo(rs);
      }
      return;
    }

    const job = rs.queue[rs.idx];
    const maxAttempts = (rs.maxRetries ?? 0) + 1;
    log(`Job ${rs.idx + 1}/${rs.queue.length}: ASIN=${job.asin} ZIP=${job.zip}`);

    let finalResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        log(`  Retry ${attempt - 1}/${maxAttempts - 1}…`);
        await sleep(1200);
      }

      const attemptResult = await runAttempt(job, rs, tabId, attempt);
      finalResult = attemptResult;

      if (!shouldRetry(attemptResult.status) || attempt === maxAttempts) {
        break;
      }

      log(`  Attempt failed with ${attemptResult.status}, will retry.`);
      if (attemptResult.status === 'ZIP_SET_FAILED') lastZip = null;
    }

    await appendResult(finalResult);
    renderResults(await getResults());

    log(`  Result: ${finalResult.status} | Sold by "${finalResult.featured_sold_by}" | You=${finalResult.is_you_featured ? 'YES' : 'NO'} | Qty=${finalResult.featured_qty_available || 'n/a'}`);

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
  if (rs) {
    rs.running = false;
    await setRunstate(rs);
    updateInfo(rs);
  }
}

/* ── Buttons / Filters ─────────────────────────── */

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

  const headers = ['run_id', 'timestamp', 'asin', 'zip', 'status', 'featured_sold_by', 'is_you_featured', 'featured_qty_available', 'retry_count', 'mode', 'delay_sec', 'notes', 'url'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const d = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({ url, filename: `buy-box-mapper_${d}.csv`, saveAs: true });
});

$('btnAmazon').addEventListener('click', async () => {
  const rs = await getRunstate();
  if (rs?.workTabId) {
    chrome.tabs.update(rs.workTabId, { active: true });
  } else {
    chrome.tabs.create({ url: 'https://www.amazon.com' });
  }
});

$('fltSearch').addEventListener('input', async (e) => {
  filters.search = e.target.value;
  renderResults(await getResults());
});
$('fltStatus').addEventListener('change', async (e) => {
  filters.status = e.target.value;
  renderResults(await getResults());
});
$('fltYou').addEventListener('change', async (e) => {
  filters.you = e.target.value;
  renderResults(await getResults());
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
