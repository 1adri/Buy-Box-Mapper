/* popup.js – Buy Box Mapper */

const $ = (s) => document.getElementById(s);

const ZIP_PRESETS = {
  "Top 10 US metros": ['10001', '90001', '60601', '77001', '85001', '19103', '78205', '92101', '75201', '30301'],
  "West Coast hubs": ['94105', '90001', '92101', '98101', '97205', '95814', '89501', '89101'],
  "Northeast corridor": ['10001', '07030', '19103', '02108', '20001', '14202', '06103', '02903'],
  "Sun Belt growth": ['33101', '30301', '28202', '37203', '78701', '73301', '85001', '89101'],
  "Texas triangle": ['75201', '77001', '73301', '78701', '76102', '78205', '75001', '78758']
};

function parseAsins(text) {
  return text.split(/\n/)
    .map(l => l.trim().replace(/[^A-Za-z0-9]/g, ''))
    .filter(a => /^[A-Z0-9]{10}$/i.test(a))
    .map(a => a.toUpperCase());
}

function parseZips(text) {
  return text.split(/\n/)
    .map(l => l.trim().replace(/\D/g, ''))
    .filter(z => /^\d{5}$/.test(z));
}

function buildQueue(asins, zips, mode) {
  const queue = [];
  if (mode === 'zip_then_asin') {
    for (const zip of zips) for (const asin of asins) queue.push({ asin, zip });
  } else {
    for (const asin of asins) for (const zip of zips) queue.push({ asin, zip });
  }
  return queue;
}

// Load saved inputs
chrome.storage.local.get(['bbgs_inputs'], (d) => {
  const inp = d.bbgs_inputs || {};
  if (inp.sellerName) $('sellerName').value = inp.sellerName;
  if (inp.asins) $('asins').value = inp.asins;
  if (inp.zips) $('zips').value = inp.zips;
  if (inp.delay) $('delay').value = inp.delay;
  if (inp.mode) $('mode').value = inp.mode;
});

function saveInputs() {
  chrome.storage.local.set({ bbgs_inputs: {
    sellerName: $('sellerName').value,
    asins: $('asins').value,
    zips: $('zips').value,
    delay: $('delay').value,
    mode: $('mode').value
  }});
}

function showStatus(msg) { $('status').textContent = msg; }

function populateZipPresets() {
  const preset = $('zipPreset');
  for (const name of Object.keys(ZIP_PRESETS)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    preset.appendChild(option);
  }
}

function getPresetZips() {
  const selected = $('zipPreset').value;
  return ZIP_PRESETS[selected] || [];
}

function applyZipPreset(append) {
  const presetZips = getPresetZips();
  if (!presetZips.length) return showStatus('Select a ZIP preset first.');

  const currentZips = parseZips($('zips').value);
  const merged = append ? [...new Set([...currentZips, ...presetZips])] : presetZips;
  $('zips').value = merged.join('\n');
  saveInputs();
  showStatus(`${append ? 'Appended' : 'Loaded'} ${presetZips.length} ZIPs from "${$('zipPreset').value}".`);
}

const modeHints = {
  zip_then_asin: "Sets one ZIP, checks all ASINs there, then moves to the next ZIP. Fewer ZIP changes = faster.",
  asin_then_zip: "Picks one ASIN, checks it across all ZIPs, then moves to the next ASIN. Good for per-product analysis."
};
function updateModeHint() { $('modeHint').textContent = modeHints[$('mode').value]; }
$('mode').addEventListener('change', updateModeHint);
$('btnPresetReplace').addEventListener('click', () => applyZipPreset(false));
$('btnPresetAppend').addEventListener('click', () => applyZipPreset(true));

$('btnStart').addEventListener('click', () => {
  saveInputs();
  const sellerName = $('sellerName').value.trim();
  const asins = parseAsins($('asins').value);
  const zips = parseZips($('zips').value);
  const delaySec = Math.max(10, parseInt($('delay').value) || 25);
  const mode = $('mode').value;

  if (!sellerName) return showStatus('⚠ Enter seller name.');
  if (!asins.length) return showStatus('⚠ Enter at least one valid ASIN.');
  if (!zips.length) return showStatus('⚠ Enter at least one valid ZIP code.');

  const queue = buildQueue(asins, zips, mode);
  const runstate = {
    running: true,
    stopRequested: false,
    sellerName,
    delaySec,
    mode,
    queue,
    idx: 0,
    workTabId: null,
    startedAt: Date.now()
  };

  chrome.storage.local.set({ bbgs_runstate: runstate }, () => {
    showStatus(`Started! ${queue.length} jobs queued. Opening runner…`);
    chrome.tabs.create({ url: chrome.runtime.getURL('runner.html') });
  });
});

$('btnStop').addEventListener('click', () => {
  chrome.storage.local.get(['bbgs_runstate'], (d) => {
    const rs = d.bbgs_runstate;
    if (rs) {
      rs.stopRequested = true;
      rs.running = false;
      chrome.storage.local.set({ bbgs_runstate: rs }, () => showStatus('Stop requested.'));
    } else {
      showStatus('Not running.');
    }
  });
});

$('btnExport').addEventListener('click', () => {
  chrome.storage.local.get(['bbgs_results'], (d) => {
    const rows = d.bbgs_results || [];
    if (!rows.length) return showStatus('No results to export.');
    exportCsv(rows);
  });
});

$('btnClear').addEventListener('click', () => {
  if (confirm('Clear all results?')) {
    chrome.storage.local.remove('bbgs_results', () => showStatus('Results cleared.'));
  }
});

$('btnRunner').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('runner.html') });
});

function exportCsv(rows) {
  const headers = ['timestamp','asin','zip','status','featured_sold_by','is_you_featured','notes','url'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const d = new Date().toISOString().slice(0,10);
  chrome.downloads.download({ url, filename: `buy-box-mapper_${d}.csv`, saveAs: true });
}

populateZipPresets();
updateModeHint();
