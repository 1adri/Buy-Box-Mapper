/* popup.js – Buy Box Mapper */

const $ = (s) => document.getElementById(s);

const ZIP_PRESETS = {
  'USA “Most Coverage” (balanced national sample)': ['10001', '02108', '20001', '33131', '30301', '60601', '75201', '80202', '85004', '98101', '90012', '94105'],
  'West (Pacific Coast + nearby)': ['98101', '97205', '94105', '95814', '94607', '90012', '92101', '93101', '89101', '89501'],
  'Mountain (Rockies / Intermountain)': ['80202', '84101', '83702', '87102', '85004', '82001', '68102', '59101', '59802', '83440'],
  'Central (Midwest + South-Central)': ['60601', '55401', '64106', '63101', '46204', '43215', '37219', '75201', '77002', '73102'],
  'East (Northeast + Southeast Atlantic)': ['10001', '02108', '19103', '20001', '15222', '28202', '27601', '30301', '32202', '33131']
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

function extractAsinFromUrl(url) {
  if (!url) return null;
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})(?:&|$)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function addAsinToList(asin) {
  const currentAsins = parseAsins($('asins').value);
  if (currentAsins.includes(asin)) {
    showStatus(`ASIN ${asin} is already in the list.`);
    return;
  }
  const nextAsins = [asin, ...currentAsins];
  $('asins').value = nextAsins.join('\n');
  saveInputs();
  showStatus(`Added ASIN ${asin} from current tab.`);
}

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
  zip_then_asin: 'Sets one ZIP, checks all ASINs there, then moves to the next ZIP. Fewer ZIP changes = faster.',
  asin_then_zip: 'Picks one ASIN, checks it across all ZIPs, then moves to the next ASIN. Good for per-product analysis.'
};

function updateModeHint() { $('modeHint').textContent = modeHints[$('mode').value]; }

['sellerName', 'asins', 'zips', 'delay', 'mode'].forEach((id) => {
  const el = $(id);
  el.addEventListener('input', saveInputs);
  el.addEventListener('change', saveInputs);
});

$('mode').addEventListener('change', updateModeHint);
$('btnPresetReplace').addEventListener('click', () => applyZipPreset(false));
$('btnPresetAppend').addEventListener('click', () => applyZipPreset(true));

$('btnUseCurrentAsin').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.url) return showStatus('Could not read current tab URL.');

    const isAmazonProductPage = /^https?:\/\/(www\.|smile\.)?amazon\.com\//i.test(tab.url);
    if (!isAmazonProductPage) return showStatus('Open an Amazon product page, then try again.');

    const asin = extractAsinFromUrl(tab.url);
    if (!asin) return showStatus('No ASIN found in current Amazon URL.');

    addAsinToList(asin);
  });
});

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
  const headers = ['timestamp', 'asin', 'zip', 'status', 'featured_sold_by', 'is_you_featured', 'notes', 'url'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const d = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({ url, filename: `buy-box-mapper_${d}.csv`, saveAs: true });
}

populateZipPresets();
updateModeHint();
