/* popup.js – Buy Box Mapper */

const $ = (s) => document.getElementById(s);

const BUILTIN_ZIP_PRESETS = {
  'USA “Most Coverage” (balanced national sample)': ['10001', '02108', '20001', '33131', '30301', '60601', '75201', '80202', '85004', '98101', '90012', '94105'],
  'West (Pacific Coast + nearby)': ['98101', '97205', '94105', '95814', '94607', '90012', '92101', '93101', '89101', '89501'],
  'Mountain (Rockies / Intermountain)': ['80202', '84101', '83702', '87102', '85004', '82001', '68102', '59101', '59802', '83440'],
  'Central (Midwest + South-Central)': ['60601', '55401', '64106', '63101', '46204', '43215', '37219', '75201', '77002', '73102'],
  'East (Northeast + Southeast Atlantic)': ['10001', '02108', '19103', '20001', '15222', '28202', '27601', '30301', '32202', '33131']
};

let customZipPresets = {};

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

function showStatus(msg) { $('status').textContent = msg; }

function getAllPresets() {
  return { ...BUILTIN_ZIP_PRESETS, ...customZipPresets };
}

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

function saveInputs() {
  chrome.storage.local.set({ bbgs_inputs: {
    sellerName: $('sellerName').value,
    asins: $('asins').value,
    zips: $('zips').value,
    delay: $('delay').value,
    maxRetries: $('maxRetries').value,
    mode: $('mode').value
  }});
}

function loadInputs() {
  chrome.storage.local.get(['bbgs_inputs'], (d) => {
    const inp = d.bbgs_inputs || {};
    if (inp.sellerName) $('sellerName').value = inp.sellerName;
    if (inp.asins) $('asins').value = inp.asins;
    if (inp.zips) $('zips').value = inp.zips;
    if (inp.delay) $('delay').value = inp.delay;
    if (inp.maxRetries != null) $('maxRetries').value = inp.maxRetries;
    if (inp.mode) $('mode').value = inp.mode;
  });
}

function populateZipPresets() {
  const preset = $('zipPreset');
  const selected = preset.value;
  preset.innerHTML = '<option value="">Load ZIP preset…</option>';

  for (const [name] of Object.entries(BUILTIN_ZIP_PRESETS)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name} · Built-in`;
    option.dataset.kind = 'builtin';
    preset.appendChild(option);
  }

  for (const [name] of Object.entries(customZipPresets)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = `${name} · Custom`;
    option.dataset.kind = 'custom';
    preset.appendChild(option);
  }

  if (selected && [...preset.options].some(o => o.value === selected)) {
    preset.value = selected;
  }
}

function loadCustomPresets(callback) {
  chrome.storage.local.get(['bbgs_custom_zip_presets'], (d) => {
    customZipPresets = d.bbgs_custom_zip_presets || {};
    populateZipPresets();
    if (callback) callback();
  });
}

function saveCustomPresets(callback) {
  chrome.storage.local.set({ bbgs_custom_zip_presets: customZipPresets }, () => {
    populateZipPresets();
    if (callback) callback();
  });
}

function getPresetZips() {
  const selected = $('zipPreset').value;
  return getAllPresets()[selected] || [];
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

function saveCurrentAsCustomPreset() {
  const name = $('presetName').value.trim();
  if (!name) return showStatus('Enter a custom preset name first.');
  if (BUILTIN_ZIP_PRESETS[name]) return showStatus('That name is reserved by a built-in preset.');

  const zips = parseZips($('zips').value);
  if (!zips.length) return showStatus('Enter ZIPs before saving a custom preset.');

  customZipPresets[name] = [...new Set(zips)];
  saveCustomPresets(() => {
    $('zipPreset').value = name;
    showStatus(`Saved custom preset "${name}" (${zips.length} ZIPs).`);
  });
}

function deleteSelectedCustomPreset() {
  const selected = $('zipPreset').value;
  if (!selected) return showStatus('Select a preset to delete.');
  if (!customZipPresets[selected]) return showStatus('Only custom presets can be deleted.');

  delete customZipPresets[selected];
  saveCustomPresets(() => {
    $('zipPreset').value = '';
    showStatus(`Deleted custom preset "${selected}".`);
  });
}

const modeHints = {
  zip_then_asin: 'Sets one ZIP, checks all ASINs there, then moves to the next ZIP. Fewer ZIP changes = faster.',
  asin_then_zip: 'Picks one ASIN, checks it across all ZIPs, then moves to the next ASIN. Good for per-product analysis.'
};

function updateModeHint() { $('modeHint').textContent = modeHints[$('mode').value]; }

['sellerName', 'asins', 'zips', 'delay', 'maxRetries', 'mode'].forEach((id) => {
  const el = $(id);
  el.addEventListener('input', saveInputs);
  el.addEventListener('change', saveInputs);
});

$('mode').addEventListener('change', updateModeHint);
$('btnPresetReplace').addEventListener('click', () => applyZipPreset(false));
$('btnPresetAppend').addEventListener('click', () => applyZipPreset(true));
$('btnPresetSave').addEventListener('click', saveCurrentAsCustomPreset);
$('btnPresetDelete').addEventListener('click', deleteSelectedCustomPreset);

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
  const delaySec = Math.max(10, parseInt($('delay').value, 10) || 25);
  const maxRetries = Math.max(0, Math.min(5, parseInt($('maxRetries').value, 10) || 0));
  const mode = $('mode').value;

  if (!sellerName) return showStatus('⚠ Enter seller name.');
  if (!asins.length) return showStatus('⚠ Enter at least one valid ASIN.');
  if (!zips.length) return showStatus('⚠ Enter at least one valid ZIP code.');

  const queue = buildQueue(asins, zips, mode);
  const runstate = {
    runId: `run_${Date.now()}`,
    running: true,
    stopRequested: false,
    sellerName,
    delaySec,
    maxRetries,
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
  const headers = ['run_id', 'timestamp', 'asin', 'zip', 'status', 'featured_sold_by', 'is_you_featured', 'featured_qty_available', 'retry_count', 'mode', 'delay_sec', 'notes', 'url'];
  const csv = [headers.join(',')];
  for (const r of rows) {
    csv.push(headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const d = new Date().toISOString().slice(0, 10);
  chrome.downloads.download({ url, filename: `buy-box-mapper_${d}.csv`, saveAs: true });
}

loadInputs();
loadCustomPresets();
updateModeHint();
