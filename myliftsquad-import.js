var API = 'https://myliftsquad-web.gooseyirl.workers.dev';
var BUNDLE_API = 'https://myliftsquad-api.gooseyirl.workers.dev';
var HISTORY_KEY = 'mls_history';
var HISTORY_MAX = 5;
var oplSource = localStorage.getItem('mls_opl_source') || 'opl';
function loadPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch(e) { return fallback; } }
function savePref(key, val) { try { localStorage.setItem(key, val); } catch(e) {} }

async function setOplSource(src) {
  if (src === oplSource) return;
  if (st.phase === 'done' || st.phase === 'resolving') {
    var srcName = src === 'ipf' ? 'OpenIPF' : 'OpenPowerlifting';
    if (!confirm('Switching to ' + srcName + ' will re-look up all athletes, which may take a moment. Continue?')) return;
  }
  oplSource = src;
  try { localStorage.setItem('mls_opl_source', src); } catch(e) {}
  if (st.phase === 'done' || st.phase === 'resolving') {
    st.resolved = new Array(st.lifters.length).fill(null);
    st.resolvedCount = 0;
    st.phase = 'resolving';
    render();
    await doResolveAll();
    st.phase = 'done';
    render();
  }
}

function setMetric(m) {
  st.metric = m;
  savePref('mls_metric', m);
  render();
}

function oplProfileBase() {
  return oplSource === 'ipf' ? 'https://www.openipf.org/u' : 'https://www.openpowerlifting.org/u';
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch(e) { return []; }
}

function saveToHistory() {
  if (!st.meet || !st.meetId) return;
  var history = getHistory().filter(function(h) { return h.meetId !== st.meetId; });
  history.unshift({ savedAt: new Date().toISOString(), meetId: st.meetId, lcUrl: st.lcUrl, nameOverride: st.nameOverride, meet: st.meet, lifters: st.lifters, resolved: st.resolved, bundleCodes: st.bundleCodes });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_MAX))); } catch(e) {}
}

function loadFromHistory(meetId) {
  var history = getHistory();
  var entry = null;
  for (var i = 0; i < history.length; i++) { if (history[i].meetId === meetId) { entry = history[i]; break; } }
  if (!entry) return;
  st.phase = 'done';
  st.meetId = entry.meetId;
  st.lcUrl = entry.lcUrl;
  st.nameOverride = entry.nameOverride || '';
  st.meet = entry.meet;
  st.lifters = entry.lifters;
  st.resolved = entry.resolved;
  st.resolvedCount = entry.resolved.filter(Boolean).length;
  st.bundleCodes = entry.bundleCodes;
  st.editingIdx = -1;
  st.lookupError = null;
  st.genError = null;
  st.error = null;
  st.saved = true;
  render();
}

function deleteFromHistory(meetId) {
  var history = getHistory().filter(function(h) { return h.meetId !== meetId; });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch(e) {}
  render();
}

function histFlightCount(lifters) {
  var f = {};
  for (var i = 0; i < lifters.length; i++) f[lifters[i].flight || '?'] = 1;
  return Object.keys(f).length;
}

var st = {
  phase: 'input',
  lcUrl: '',
  nameOverride: '',
  meetId: null,
  meet: null,
  lifters: [],
  resolved: [],
  resolvedCount: 0,
  editingIdx: -1,
  editingUrl: '',
  lookupError: null,
  sortCol: null,
  sortDir: 'asc',
  bundleCodes: null,
  genError: null,
  error: null,
  saved: false,
  panelSlug: null,
  panelName: '',
  panelData: null,
  panelLoading: false,
  panelError: null,
  shareCode: null,
  shareLoading: false,
  shareError: null,
  metric: loadPref('mls_metric', 'total'),
  sortCol: loadPref('mls_sort_col', 'lot') || 'lot',
  sortDir: loadPref('mls_sort_dir', 'asc')
};

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function groupByFlight(lifters) {
  var g = {};
  for (var i = 0; i < lifters.length; i++) {
    var f = lifters[i].flight || '?';
    if (!g[f]) g[f] = [];
    g[f].push({lifter: lifters[i], idx: i});
  }
  return g;
}

function buildTableRows(entries) {
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var lifter = e.lifter;
    var r = st.resolved[e.idx];
    var isEditing = st.editingIdx === e.idx;

    html += '<div class="lifter-row' + (isEditing ? ' lifter-row-editing' : '') + '">';
    html += '<div class="lifter-col-main">';
    html += '<div class="lifter-row-name">' + esc(lifter.name) + lcCatHtml(lifter) + '</div>';
    if (!isEditing) html += lcLotLineHtml(lifter);

    if (isEditing) {
      var curBclass = r && r.oplSlug ? (r.confidence === 'high' ? 'bh' : r.confidence === 'medium' ? 'bm' : r.confidence === 'manual' ? 'bmanual' : 'bl') : 'bn';
      var curBlabel = r && r.oplSlug ? (r.confidence === 'manual' ? 'Manual' : r.confidence) : 'None';
      html += '<div class="edit-row" style="margin-top:6px">';
      html += '<input type="url" id="eurl-' + e.idx + '" class="edit-input" placeholder="https://www.openpowerlifting.org/u/…" value="' + esc(st.editingUrl) + '">';
      html += '<button id="elookup-' + e.idx + '" class="btn-sm btn-sm-primary" onclick="doLookup(' + e.idx + ')">Lookup</button>';
      html += '<button class="btn-sm btn-sm-ghost" onclick="clearMatch(' + e.idx + ')" title="Mark as no OpenPowerlifting profile">No match</button>';
      html += '<button class="btn-sm btn-sm-ghost" onclick="cancelEdit()" title="Cancel">✕</button>';
      html += '</div>';
      if (st.lookupError) html += '<p class="lookup-err">' + esc(st.lookupError) + '</p>';
      html += '</div>';
      html += '<div class="lifter-col-right"><span class="badge ' + curBclass + '">' + curBlabel + '</span></div>';
    } else if (!r) {
      html += '</div>';
      html += '<div class="lifter-col-right"><span class="badge bp">Resolving…</span></div>';
    } else if (r.oplSlug) {
      html += '<div class="lifter-row-meta">';
      html += '<a class="slug" href="' + oplProfileBase() + '/' + esc(r.oplSlug) + '" target="_blank" rel="noopener">' + esc(r.oplSlug) + '</a>';
      if (r.oplWeightClass) html += '<span class="muted hide-sm"> · </span><span class="opl-past hide-sm" title="Weight class from past OpenPowerlifting results">' + esc(r.oplWeightClass) + '</span>';
      if (r.oplTotal) html += '<span class="muted hide-sm"> · </span><span class="opl-past total-past hide-sm" title="Best total from past OpenPowerlifting results">' + esc(r.oplTotal) + '</span>';
      html += '</div>';
      html += '</div>';
      var bclass2 = r.confidence === 'high' ? 'bh' : r.confidence === 'medium' ? 'bm' : r.confidence === 'manual' ? 'bmanual' : 'bl';
      var blabel2 = r.confidence === 'manual' ? 'Manual' : r.confidence;
      html += '<div class="lifter-col-right"><span class="badge ' + bclass2 + '">' + blabel2 + '</span><button class="btn-add" onclick="startEdit(' + e.idx + ')" title="Change match">✎</button></div>';
    } else if (r.confidence === 'cleared') {
      html += '<div class="lifter-row-meta">';
      html += '<span class="muted">no OPL profile</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="lifter-col-right"><span class="badge bn">No match</span><button class="btn-add" onclick="startEdit(' + e.idx + ')" title="Change match">✎</button></div>';
    } else {
      html += '</div>';
      html += '<div class="lifter-col-right"><span class="badge bn">None</span><button class="btn-add" onclick="startEdit(' + e.idx + ')">+ Add</button></div>';
    }

    html += '</div>';
  }
  return html;
}


function parseWc(s) {
  if (!s) return Infinity;
  var n = parseFloat(s);
  return isNaN(n) ? Infinity : n;
}

function setSort(col) {
  if (st.sortCol === col) {
    st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    st.sortCol = col;
    st.sortDir = 'asc';
  }
  savePref('mls_sort_col', st.sortCol || '');
  savePref('mls_sort_dir', st.sortDir);
  render();
}

function lcCategory(lifter) {
  // Competition category from LiftingCast, e.g. "M-105", "F-63"
  if (!lifter || !lifter.weightClass) return '';
  var g = (lifter.gender || '').toUpperCase().charAt(0);
  return (g === 'M' || g === 'F') ? g + '-' + lifter.weightClass : lifter.weightClass;
}

function lcLot(lifter) {
  if (!lifter || lifter.lot === undefined || lifter.lot === null || lifter.lot === '') return '';
  return String(lifter.lot);
}

function parseLotNum(v) {
  if (v === undefined || v === null || v === '') return Infinity; // unset sorts last
  var n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? Infinity : n;
}

function lcCatHtml(lifter) {
  // Competition category chip, shown inline beside the athlete's name.
  var cat = lcCategory(lifter);
  return cat ? ' <span class="lc-cat" title="Category at this competition (from LiftingCast)">' + esc(cat) + '</span>' : '';
}

function lcLotLineHtml(lifter) {
  // Lot number on its own line beneath the athlete's name.
  var lot = lcLot(lifter);
  return lot ? '<div class="lifter-row-lot" title="Lot number at this competition">Lot ' + esc(lot) + '</div>' : '';
}

function sortEntries(entries) {
  if (!st.sortCol) return entries;
  var dir = st.sortDir === 'asc' ? 1 : -1;
  return entries.slice().sort(function(a, b) {
    if (st.sortCol === 'name') {
      return dir * a.lifter.name.localeCompare(b.lifter.name);
    }
    if (st.sortCol === 'class') {
      var wa = parseWc(a.lifter.weightClass), wb = parseWc(b.lifter.weightClass);
      if (wa !== wb) return dir * (wa - wb);
      return a.lifter.name.localeCompare(b.lifter.name);
    }
    if (st.sortCol === 'lot') {
      var la = parseLotNum(a.lifter.lot), lb = parseLotNum(b.lifter.lot);
      if (la !== lb) return dir * (la - lb);
      return a.lifter.name.localeCompare(b.lifter.name);
    }
    if (st.sortCol === 'total') {
      var ra = st.resolved[a.idx], rb = st.resolved[b.idx];
      var va = ra ? parseFloat(st.metric === 'gl' ? ra.oplGlPoints : ra.oplTotal) || 0 : 0;
      var vb = rb ? parseFloat(st.metric === 'gl' ? rb.oplGlPoints : rb.oplTotal) || 0 : 0;
      if (va !== vb) return dir * (va - vb);
      return a.lifter.name.localeCompare(b.lifter.name);
    }
    return 0;
  });
}

function confHelpHtml() {
  var tip = 'How well each lifter was matched to an OpenPowerlifting profile:\n\n' +
    '• High — strong match on name and details; very likely correct.\n' +
    '• Medium — probable match; worth a quick check.\n' +
    '• Low — weak match; please verify before sharing.\n' +
    '• Manual — you set this profile by hand.\n' +
    '• None / No match — no OpenPowerlifting profile (e.g. hasn\'t competed).\n\n' +
    'Tap the ✎ pencil on any lifter to correct a match.';
  return '<span class="conf-help" title="' + esc(tip) + '" role="img" aria-label="What do the confidence levels mean?">?</span>';
}

function thSort(label, col) {
  var active = st.sortCol === col;
  var arrow = active ? (st.sortDir === 'asc' ? ' &#8593;' : ' &#8595;') : '';
  return '<button class="sort-btn' + (active ? ' sort-btn-active' : '') + '" onclick="setSort(\'' + col + '\')">' + label + arrow + '</button>';
}

function buildFlightsHTML() {
  var groups = groupByFlight(st.lifters);
  var flights = Object.keys(groups).sort();
  var html = '';
  for (var fi = 0; fi < flights.length; fi++) {
    var f = flights[fi];
    var entries = groups[f];
    html += '<div class="flight-section">';
    html += '<div class="flight-header">';
    html += '<span class="flight-badge">' + esc(f) + '</span>';
    html += '<span class="flight-title">Flight ' + esc(f) + '</span>';
    html += '<span class="flight-count">' + entries.length + ' athletes</span>';
    html += '</div>';
    html += '<div class="lifter-list">';
    html += '<div class="lifter-list-header">';
    html += '<div class="lifter-col-main">' + thSort('Lifter', 'name') + '<span style="opacity:.3;margin:0 8px">·</span>' + thSort('Class', 'class') + '<span style="opacity:.3;margin:0 8px">·</span>' + thSort('Lot', 'lot') + '</div>';
    html += '<div class="lifter-col-right" style="display:flex;align-items:center;gap:12px"><span style="font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);display:inline-flex;align-items:center;gap:4px">Confidence' + confHelpHtml() + '</span>' + thSort(st.metric === 'gl' ? 'GL Pts' : 'Total', 'total') + '</div>';
    html += '</div>';
    html += buildTableRows(sortEntries(entries));
    html += '</div></div>';
  }
  return html;
}


function meetLabel() {
  if (st.nameOverride) return st.nameOverride;
  if (!st.meet) return '';
  return st.meet.federation + ' - ' + st.meet.date;
}

async function buildBundleCodes() {
  var label = meetLabel();
  var flightMap = {};
  for (var i = 0; i < st.lifters.length; i++) {
    var lifter = st.lifters[i];
    var r = st.resolved[i];
    var f = lifter.flight || '?';
    if (!flightMap[f]) flightMap[f] = [];
    var athlete = { name: lifter.name };
    if (r && r.oplSlug) athlete.slug = r.oplSlug;
    flightMap[f].push(athlete);
  }
  var flights = Object.keys(flightMap).sort();
  var MAX = 10;
  var bundles = [];
  for (var b = 0; b < flights.length; b += MAX) {
    var chunk = flights.slice(b, b + MAX);
    var squads = chunk.map(function(fl) {
      return { name: label + ' - Flight ' + fl, athletes: flightMap[fl] };
    });
    bundles.push({ flights: chunk, squads: squads });
  }
  var codes = [];
  for (var bi = 0; bi < bundles.length; bi++) {
    var bundle = bundles[bi];
    var res = await fetch(BUNDLE_API + '/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ squads: bundle.squads })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    codes.push({ code: data.code, flights: bundle.flights });
  }
  return codes;
}

async function doShare() {
  st.shareLoading = true;
  st.shareError = null;
  st.shareCode = null;
  render();
  try {
    // Generate app-importable bundle codes
    var bundleCodes = await buildBundleCodes();
    st.bundleCodes = bundleCodes;

    // Also store web tool state for browser sharing
    var state = {
      meetId: st.meetId, lcUrl: st.lcUrl, nameOverride: st.nameOverride,
      meet: st.meet, lifters: st.lifters, resolved: st.resolved, bundleCodes: bundleCodes
    };
    var res = await fetch(API + '/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Share failed');
    st.shareCode = data.code;
    st.shareLoading = false;
    render();
  } catch(err) {
    st.shareError = err.message || String(err);
    st.shareLoading = false;
    render();
  }
}

function copyShareUrl() {
  var url = shareUrl();
  if (!url) return;
  navigator.clipboard.writeText(url).then(function() {
    var btn = document.getElementById('copyurlbtn');
    if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(function(){ btn.textContent = 'Copy Link'; btn.classList.remove('copied'); }, 2000); }
  });
}

function shareUrl() {
  if (!st.shareCode) return '';
  return window.location.origin + window.location.pathname + '?share=' + st.shareCode;
}

function copyShareCode() {
  if (!st.shareCode) return;
  navigator.clipboard.writeText(st.shareCode).then(function() {
    var btn = document.getElementById('copybtn');
    if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(function(){ btn.textContent = 'Copy Code'; btn.classList.remove('copied'); }, 2000); }
  });
}

async function loadFromShareCode(code) {
  st.phase = 'fetching';
  render();
  try {
    var res = await fetch(API + '/api/share?code=' + encodeURIComponent(code));
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Share link not found');
    var s = data.state;
    st.phase = 'done';
    st.meetId = s.meetId || null;
    st.lcUrl = s.lcUrl || '';
    st.nameOverride = s.nameOverride || '';
    st.meet = s.meet;
    st.lifters = s.lifters;
    st.resolved = s.resolved;
    st.resolvedCount = (s.resolved || []).filter(Boolean).length;
    st.bundleCodes = s.bundleCodes || null;
    st.saved = true;
    st.shareCode = null;
    render();
  } catch(err) {
    st.phase = 'error';
    st.error = err.message || String(err);
    render();
  }
}

function formatPlace(p) {
  if (!p) return '';
  if (p === 'DQ' || p === 'NS' || p === 'DD' || p === 'G') return p;
  var n = parseInt(p);
  if (isNaN(n)) return p;
  return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
}

function openPanel(slug, name) {
  if (!slug) return;
  st.panelSlug = slug;
  st.panelName = name;
  st.panelData = null;
  st.panelLoading = true;
  st.panelError = null;
  document.getElementById('panel-overlay').classList.add('open');
  document.getElementById('panel').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderPanel();
  fetchPanelData(slug);
}

function closePanel() {
  document.getElementById('panel-overlay').classList.remove('open');
  document.getElementById('panel').classList.remove('open');
  document.body.style.overflow = '';
}

async function fetchPanelData(slug) {
  try {
    var res = await fetch(API + '/api/lifter?slug=' + encodeURIComponent(slug) + '&source=' + oplSource);
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Not found');
    st.panelData = data;
    st.panelLoading = false;
  } catch(err) {
    st.panelLoading = false;
    st.panelError = err.message || String(err);
  }
  renderPanel();
}

function renderPanel() {
  var el = document.getElementById('panel-content');
  if (!el) return;
  var html = '<div class="panel-header">';
  html += '<div class="panel-title">' + esc(st.panelName) + '</div>';
  html += '<div class="panel-header-actions">';
  if (st.panelSlug) html += '<a class="panel-opl" href="' + oplProfileBase() + '/' + esc(st.panelSlug) + '" target="_blank" rel="noopener">' + (oplSource === 'ipf' ? 'OpenIPF' : 'OpenPowerlifting') + ' &#8599;</a>';
  html += '<button class="panel-close" onclick="closePanel()">&#10005;</button>';
  html += '</div></div>';
  if (st.panelLoading) {
    html += '<div class="loading"><div class="spinner"></div></div>';
  } else if (st.panelError) {
    html += '<div class="err-box" style="margin:16px">' + esc(st.panelError) + '</div>';
  } else if (st.panelData) {
    var meets = st.panelData.meets;
    if (!meets || !meets.length) {
      html += '<p class="panel-empty">No competition history found.</p>';
    } else {
      for (var mi = 0; mi < meets.length; mi++) {
        var m = meets[mi];
        html += '<div class="meet-row"><div class="meet-row-body">';
        html += '<div class="meet-row-name">' + esc(m.meet || 'Unknown Meet') + '</div>';
        var meta = [];
        if (m.date) meta.push(m.date);
        if (m.federation) meta.push(m.federation);
        if (m.weightClass) meta.push(m.weightClass + ' kg');
        if (m.equipment) meta.push(m.equipment);
        if (meta.length) html += '<div class="meet-row-meta">' + esc(meta.join(' · ')) + '</div>';
        var sbd = [];
        if (m.squat && parseFloat(m.squat) > 0) sbd.push(['S', formatKg(m.squat)]);
        if (m.bench && parseFloat(m.bench) > 0) sbd.push(['B', formatKg(m.bench)]);
        if (m.deadlift && parseFloat(m.deadlift) > 0) sbd.push(['D', formatKg(m.deadlift)]);
        if (sbd.length) {
          html += '<div class="ath-sbd" style="margin-top:4px">';
          for (var si = 0; si < sbd.length; si++) {
            if (si > 0) html += '  ';
            html += '<span class="ath-sbd-l">' + sbd[si][0] + '</span><span class="ath-sbd-v"> ' + sbd[si][1] + '</span>';
          }
          html += '</div>';
        }
        html += '</div><div class="meet-row-right">';
        var mTotal = parseFloat(m.total || ''), mGl = parseFloat(m.glPoints || '');
        if (st.metric === 'gl') {
          if (mGl > 0) html += '<div class="ath-total">' + esc(mGl.toFixed(2)) + ' GL</div>';
          if (mTotal > 0) html += '<div style="font-size:.75rem;color:var(--text-muted);text-align:right;margin-top:2px">' + esc(formatKg(m.total)) + '</div>';
        } else {
          if (mTotal > 0) html += '<div class="ath-total">' + esc(formatKg(m.total)) + '</div>';
          if (mGl > 0) html += '<div style="font-size:.75rem;color:var(--text-muted);text-align:right;margin-top:2px">' + esc(mGl.toFixed(2)) + ' GL</div>';
        }
        if (m.place) html += '<div class="meet-place">' + esc(formatPlace(m.place)) + '</div>';
        html += '</div></div>';
      }
    }
  }
  el.innerHTML = html;
}

function formatKg(val) {
  if (!val) return '';
  var n = parseFloat(val);
  if (isNaN(n) || n <= 0) return '';
  return (n % 1 === 0 ? String(n) : String(n)) + ' kg';
}

function buildAthleteCard(lifter, r) {
  var clickable = r && r.oplSlug;
  var html = '<div class="ath-card' + (clickable ? ' ath-card-clickable' : '') + '"' +
    (clickable ? ' onclick="openPanel(\'' + esc(r.oplSlug) + '\',\'' + esc(lifter.name.replace(/'/g,'\\\'')) + '\')"' : '') + '>';
  html += '<div class="ath-body">';
  var lcCardCat = lcCategory(lifter);
  var nameCat = lcCardCat ? ' <span class="ath-cat" title="Category at this competition">' + esc(lcCardCat) + '</span>' : '';
  html += '<div class="ath-name">' + esc(lifter.name) + nameCat + '</div>';
  var lcCardLot = lcLot(lifter);
  if (lcCardLot) html += '<div class="ath-lc"><span title="Lot number at this competition">Lot ' + esc(lcCardLot) + '</span></div>';
  if (r && r.oplSlug) {
    var wc = r.oplWeightClass || lifter.weightClass;
    var parts = [];
    if (r.oplFederation) parts.push('<span class="ath-fed">' + esc(r.oplFederation) + '</span>');
    if (wc) parts.push('<span class="ath-sec">' + esc(wc) + '</span>');
    if (r.oplEquipment) parts.push('<span class="ath-sec">' + esc(r.oplEquipment) + '</span>');
    if (parts.length) html += '<div class="ath-meta" title="Best results from past OpenPowerlifting competitions"><span class="ath-past-tag">Past PB</span>' + parts.join('<span class="ath-sep"> - </span>') + '</div>';
    var sbd = [];
    if (r.oplSquat && parseFloat(r.oplSquat) > 0) sbd.push(['S', formatKg(r.oplSquat)]);
    if (r.oplBench && parseFloat(r.oplBench) > 0) sbd.push(['B', formatKg(r.oplBench)]);
    if (r.oplDeadlift && parseFloat(r.oplDeadlift) > 0) sbd.push(['D', formatKg(r.oplDeadlift)]);
    if (sbd.length) {
      html += '<div class="ath-sbd">';
      for (var si = 0; si < sbd.length; si++) {
        if (si > 0) html += '  ';
        html += '<span class="ath-sbd-l">' + sbd[si][0] + '</span><span class="ath-sbd-v"> ' + sbd[si][1] + '</span>';
      }
      html += '</div>';
    }
  }
  html += '</div>';
  if (r && r.oplSlug) {
    var totalNum = parseFloat(r.oplTotal || '');
    var glNum = parseFloat(r.oplGlPoints || '');
    var hasTotal = totalNum > 0;
    var hasGl = glNum > 0;
    if (hasTotal || hasGl) {
      html += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">';
      if (st.metric === 'gl') {
        if (hasGl) html += '<div class="ath-total">' + esc(glNum.toFixed(2)) + ' GL</div>';
        if (hasTotal) html += '<div style="font-size:.75rem;color:var(--text-muted)">' + esc(formatKg(r.oplTotal)) + '</div>';
      } else {
        if (hasTotal) html += '<div class="ath-total">' + esc(formatKg(r.oplTotal)) + '</div>';
        if (hasGl) html += '<div style="font-size:.75rem;color:var(--text-muted)">' + esc(glNum.toFixed(2)) + ' GL</div>';
      }
      html += '</div>';
    }
  }
  html += '</div>';
  return html;
}

function buildSquadView() {
  var groups = groupByFlight(st.lifters);
  var flights = Object.keys(groups).sort();
  var html = '';
  for (var fi = 0; fi < flights.length; fi++) {
    var f = flights[fi];
    var entries = sortEntries(groups[f]);
    html += '<div class="flight-section">';
    html += '<div class="flight-header">';
    html += '<span class="flight-badge">' + esc(f) + '</span>';
    html += '<span class="flight-title">Flight ' + esc(f) + '</span>';
    html += '<span class="flight-count">' + entries.length + ' athletes</span>';
    html += '</div>';
    for (var i = 0; i < entries.length; i++) {
      html += buildAthleteCard(entries[i].lifter, st.resolved[entries[i].idx]);
    }
    html += '</div>';
  }
  return html;
}

function doSave() {
  saveToHistory();
  st.saved = true;
  render();
}

function render() {
  var app = document.getElementById('app');
  if (!app) return;
  var html = '';

  if (st.phase === 'input') {
    html = '<div class="card">' +
      '<div class="card-title">LiftingCast Meet</div>' +
      '<div class="fg"><label for="lcu">LiftingCast URL</label>' +
      '<input type="url" id="lcu" placeholder="https://liftingcast.com/meets/…" value="' + esc(st.lcUrl) + '"></div>' +
      '<div class="fg"><label for="nom">Competition name <span style="opacity:.5">(optional)</span></label>' +
      '<input type="text" id="nom" placeholder="e.g. IrishPF 2026 June Open" value="' + esc(st.nameOverride) + '">' +
      '<p class="hint">Squad names will be prefixed with this. Defaults to federation + date from LiftingCast.</p></div>' +
      '<div class="fg"><label>Data Source</label>' +
      '<div class="src-ctrl">' +
      '<button class="src-opt' + (oplSource === 'opl' ? ' active' : '') + '" id="src-opl" data-src="opl" onclick="setOplSource(this.dataset.src)">OpenPowerlifting</button>' +
      '<button class="src-opt' + (oplSource === 'ipf' ? ' active' : '') + '" id="src-ipf" data-src="ipf" onclick="setOplSource(this.dataset.src)">OpenIPF</button>' +
      '</div>' +
      '<p class="hint">OpenIPF only includes IPF-affiliated competitions.</p></div>' +
      '<button class="btn btn-primary btn-block" onclick="doFetch()">Fetch Meet</button>' +
      '</div>';

    var hist = getHistory();
    if (hist.length > 0) {
      var PERSON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>';
      html += '<div class="card"><div class="card-title">Saved Meets</div>';
      for (var hi = 0; hi < hist.length; hi++) {
        var h = hist[hi];
        var hname = h.nameOverride || (h.meet.federation + ' — ' + h.meet.date);
        var hflights = histFlightCount(h.lifters);
        var hdate = new Date(h.savedAt).toLocaleDateString(undefined, {day:'numeric',month:'short',year:'numeric'});
        html += '<div class="squad-card" onclick="loadFromHistory(\'' + esc(h.meetId) + '\')">';
        html += '<div class="squad-card-body">';
        html += '<div class="squad-card-name">' + esc(hname) + '</div>';
        html += '<div class="squad-card-meta">' + hflights + ' flight' + (hflights !== 1 ? 's' : '') + ' · saved ' + hdate + '</div>';
        if (h.bundleCodes) {
          var codes = h.bundleCodes.map(function(cc){return cc.code;}).join(', ');
          html += '<div class="squad-card-code">' + esc(codes) + '</div>';
        }
        html += '</div>';
        html += '<div class="squad-card-right">' + PERSON_ICON + '<span>' + h.lifters.length + '</span></div>';
        html += '<button class="squad-card-del" onclick="event.stopPropagation();deleteFromHistory(\'' + esc(h.meetId) + '\')" title="Remove">✕</button>';
        html += '</div>';
      }
      html += '</div>';
    }

  } else if (st.phase === 'fetching') {
    html = '<div class="loading"><div class="spinner"></div><br>Fetching meet data from LiftingCast…</div>';

  } else if (st.phase === 'resolving' || st.phase === 'done') {
    var meet = st.meet;
    html += '<div style="margin-bottom:12px"><button class="btn-back" onclick="doReset()">&#8592; Back</button></div>';
    html += '<div class="card">';
    html += '<div class="meet-meta">';
    html += '<span class="meet-name">' + esc(meet.name) + '</span>';
    html += '<span class="chip">' + esc(meet.federation) + '</span>';
    if (meet.date) html += '<span class="chip">' + esc(meet.date) + '</span>';
    html += '<span class="chip ' + (oplSource === 'ipf' ? 'chip-ipf' : 'chip-opl') + '">' + (oplSource === 'ipf' ? 'OpenIPF' : 'OpenPowerlifting') + '</span>';
    if (st.phase === 'done') {
      if (st.saved) {
        html += '<button class="btn-share" onclick="doShare()" ' + (st.shareLoading ? 'disabled' : '') + '>' + (st.shareLoading ? 'Sharing…' : 'Share') + '</button>';
        html += '<button class="btn-edit" onclick="st.saved=false;st.shareCode=null;render()">Edit</button>';
      } else {
        html += '<button class="btn-save" onclick="doSave()">Save</button>';
      }
    }
    html += '</div>';
    if (st.saved && st.shareCode) {
      html += '<div class="share-box">';
      html += '<button class="share-box-dismiss" onclick="st.shareCode=null;render()" title="Dismiss">&times;</button>';
      if (st.bundleCodes && st.bundleCodes.length === 1) {
        // Single bundle — show QR + code for app import
        html += '<div class="share-box-qr" id="share-bundle-qr-' + esc(st.bundleCodes[0].code) + '"></div>';
        html += '<div class="share-box-code">' + esc(st.bundleCodes[0].code) + '</div>';
        html += '<div class="share-box-hint">Open MyLiftSquad &rarr; Import &rarr; enter this code<br>or scan the QR code with the app</div>';
        html += '<div class="share-box-actions">';
        html += '<button class="btn-copy" onclick="navigator.clipboard.writeText(\'' + esc(st.bundleCodes[0].code) + '\').then(function(){var b=document.getElementById(\'copybtn\');if(b){b.textContent=\'Copied!\';b.classList.add(\'copied\');setTimeout(function(){b.textContent=\'Copy Code\';b.classList.remove(\'copied\');},2000);}});" id="copybtn">Copy Code</button>';
        html += '<button id="copyurlbtn" class="btn-copy-link" onclick="copyShareUrl()">Copy Link</button>';
        html += '</div>';
      } else if (st.bundleCodes && st.bundleCodes.length > 1) {
        // Multiple bundles — list codes
        html += '<div class="share-box-hint" style="font-weight:600;color:var(--text)">App Import Codes</div>';
        for (var sbi = 0; sbi < st.bundleCodes.length; sbi++) {
          var sbc = st.bundleCodes[sbi];
          html += '<div style="display:flex;align-items:center;gap:10px;width:100%">';
          html += '<span style="color:var(--text-muted);font-size:.8rem;flex:1">Flights ' + esc(sbc.flights.join(', ')) + '</span>';
          html += '<span class="share-box-code" style="font-size:1.3rem">' + esc(sbc.code) + '</span>';
          html += '<div class="share-box-qr" id="share-bundle-qr-' + esc(sbc.code) + '" style="padding:4px"></div>';
          html += '</div>';
        }
        html += '<div class="share-box-hint">Enter a code in MyLiftSquad &rarr; Import, or scan QR</div>';
        html += '<div class="share-box-actions">';
        html += '<button id="copyurlbtn" class="btn-copy-link" onclick="copyShareUrl()" style="flex:1">Copy Share Link</button>';
        html += '</div>';
      } else {
        // Fallback — no bundle codes
        html += '<div class="share-box-hint">Share link copied to clipboard.</div>';
        html += '<div class="share-box-actions">';
        html += '<button id="copyurlbtn" class="btn-copy-link" onclick="copyShareUrl()">Copy Link</button>';
        html += '</div>';
      }
      html += '<div class="share-box-expiry">This code and link expire after 30 days.</div>';
      html += '</div>';
    }
    if (st.saved && st.shareError) {
      html += '<div class="err-box" style="margin-top:10px">' + esc(st.shareError) + '</div>';
    }
    if (st.phase === 'resolving') {
      var pct = st.lifters.length > 0 ? Math.round(st.resolvedCount / st.lifters.length * 100) : 0;
      html += '<div class="prog-wrap">';
      html += '<div class="prog-bg"><div class="prog-fill" style="width:' + pct + '%"></div></div>';
      html += '<p class="prog-label">Resolving ' + (oplSource === 'ipf' ? 'OpenIPF' : 'OpenPowerlifting') + ' slugs… ' + st.resolvedCount + ' / ' + st.lifters.length + '</p>';
      html += '</div>';
    } else {
      html += '<p class="hint" style="margin-top:8px">Squad prefix: <strong>' + esc(meetLabel()) + '</strong></p>';
    }
    html += '</div>';

    if (st.phase === 'done') {
      html += '<div class="card" style="padding:16px 20px">';
      html += '<div class="card-title" style="margin-bottom:12px">View Settings</div>';
      html += '<div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">';
      html += '<div><div style="font-size:.75rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Data Source</div>';
      html += '<div class="src-ctrl">' +
        '<button class="src-opt' + (oplSource === 'opl' ? ' active' : '') + '" onclick="setOplSource(\'opl\')">OpenPowerlifting</button>' +
        '<button class="src-opt' + (oplSource === 'ipf' ? ' active' : '') + '" onclick="setOplSource(\'ipf\')">OpenIPF</button>' +
        '</div></div>';
      html += '<div><div style="font-size:.75rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Display Metric</div>';
      html += '<div class="src-ctrl">' +
        '<button class="src-opt' + (st.metric === 'total' ? ' active' : '') + '" onclick="setMetric(\'total\')">Total</button>' +
        '<button class="src-opt' + (st.metric === 'gl' ? ' active' : '') + '" onclick="setMetric(\'gl\')">GL Points</button>' +
        '</div></div>';
      if (st.saved) {
        html += '<div><div style="font-size:.75rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Sort By</div>';
        html += '<div class="src-ctrl">' +
          '<button class="src-opt' + (st.sortCol === 'lot' ? ' active' : '') + '" onclick="setSort(\'lot\')">Lot' + (st.sortCol === 'lot' ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '') + '</button>' +
          '<button class="src-opt' + (st.sortCol === 'name' ? ' active' : '') + '" onclick="setSort(\'name\')">Name' + (st.sortCol === 'name' ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '') + '</button>' +
          '<button class="src-opt' + (st.sortCol === 'class' ? ' active' : '') + '" onclick="setSort(\'class\')">Class' + (st.sortCol === 'class' ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '') + '</button>' +
          '<button class="src-opt' + (st.sortCol === 'total' ? ' active' : '') + '" onclick="setSort(\'total\')">' + (st.metric === 'gl' ? 'GL Points' : 'Total') + (st.sortCol === 'total' ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '') + '</button>' +
          '</div></div>';
      }
      html += '</div></div>';
    }

    if (st.saved) {
      html += buildSquadView();
    } else {
      html += buildFlightsHTML();
    }

    if (st.phase === 'done') {
      if (st.bundleCodes) {
        html += '<div class="card">';
        html += '<div class="card-title">Import Code' + (st.bundleCodes.length > 1 ? 's' : '') + '</div>';
        if (st.bundleCodes.length === 1) {
          html += '<div class="code-box"><div class="code-val">' + esc(st.bundleCodes[0].code) + '</div>';
          html += '<div id="qr-' + esc(st.bundleCodes[0].code) + '" class="qr-wrap"></div>';
          html += '<p class="code-hint">Open MyLiftSquad &rarr; FAB &rarr; Import Squad &rarr; enter this code</p></div>';
        } else {
          html += '<div class="multi-codes">';
          for (var ci = 0; ci < st.bundleCodes.length; ci++) {
            var item = st.bundleCodes[ci];
            html += '<div class="mc-item">';
            html += '<span class="mc-label">Flights ' + esc(item.flights.join(', ')) + '</span>';
            html += '<span class="mc-val">' + esc(item.code) + '</span>';
            html += '<div id="qr-' + esc(item.code) + '" class="qr-wrap"></div>';
            html += '</div>';
          }
          html += '</div>';
        }
        html += '<p class="hint" style="margin-top:12px;text-align:center">Codes expire after 30 days.</p>';
        html += '</div>';
      } else if (!st.saved) {
        var matched = 0;
        for (var ri = 0; ri < st.resolved.length; ri++) {
          if (st.resolved[ri] && st.resolved[ri].oplSlug) matched++;
        }
        var unmatched = st.lifters.length - matched;
        html += '<div class="card">';
        html += '<div class="sum-row">';
        html += '<div class="sum-stat"><span class="sum-num c-green">' + matched + '</span><span class="sum-label">matched</span></div>';
        if (unmatched > 0) {
          html += '<div class="sum-stat"><span class="sum-num c-warn">' + unmatched + '</span><span class="sum-label">without OPL slug</span></div>';
        }
        html += '</div>';
        if (st.genError) html += '<div class="err-box">' + esc(st.genError) + '</div>';
        html += '<button class="btn btn-primary btn-block" id="genbtn" onclick="doGenerate()">Generate Import Code</button>';
        html += '</div>';
      }
    }

  } else if (st.phase === 'error') {
    html = '<div class="err-box">' + esc(st.error) + '</div>' +
      '<button class="btn btn-secondary" onclick="doReset()">Try again</button>';
  }

  app.innerHTML = html;

  if (st.shareCode && st.bundleCodes && typeof QRCode !== 'undefined') {
    for (var sqi = 0; sqi < st.bundleCodes.length; sqi++) {
      var sqCode = st.bundleCodes[sqi].code;
      var sqEl = document.getElementById('share-bundle-qr-' + sqCode);
      if (sqEl && !sqEl.hasChildNodes()) {
        var sqSize = st.bundleCodes.length === 1 ? 160 : 80;
        new QRCode(sqEl, { text: sqCode, width: sqSize, height: sqSize, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      }
    }
  }

  if (st.bundleCodes && typeof QRCode !== 'undefined') {
    for (var qi = 0; qi < st.bundleCodes.length; qi++) {
      var qc = st.bundleCodes[qi].code;
      var qel = document.getElementById('qr-' + qc);
      if (qel && !qel.hasChildNodes()) {
        new QRCode(qel, { text: qc, width: 180, height: 180, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      }
    }
  }

  if (st.phase === 'input') {
    var ui = document.getElementById('lcu');
    var ni = document.getElementById('nom');
    if (ui) {
      ui.addEventListener('input', function() { st.lcUrl = this.value; });
      ui.addEventListener('keydown', function(e) { if (e.key === 'Enter') doFetch(); });
    }
    if (ni) ni.addEventListener('input', function() { st.nameOverride = this.value; });
  }
}

function doReset() {
  st.phase = 'input';
  st.error = null;
  st.genError = null;
  st.bundleCodes = null;
  st.saved = false;
  render();
}

async function doFetch() {
  var ui = document.getElementById('lcu');
  var ni = document.getElementById('nom');
  if (ui) st.lcUrl = ui.value.trim();
  if (ni) st.nameOverride = ni.value.trim();
  if (!st.lcUrl) { alert('Please enter a LiftingCast URL'); return; }

  st.phase = 'fetching';
  st.error = null;
  st.genError = null;
  st.bundleCodes = null;
  render();

  try {
    var res = await fetch(API + '/api/meet?url=' + encodeURIComponent(st.lcUrl));
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    st.meet = data.meet;
    st.meetId = data.meetId;
    st.lifters = data.lifters;
    st.resolved = new Array(data.lifters.length).fill(null);
    st.resolvedCount = 0;
    st.phase = 'resolving';
    render();

    await doResolveAll();
    st.phase = 'done';
    st.saved = false;
    render();
  } catch (err) {
    st.phase = 'error';
    st.error = err.message || String(err);
    render();
  }
}

async function doResolveAll() {
  var lifters = st.lifters;
  var BATCH = 5;
  for (var i = 0; i < lifters.length; i += BATCH) {
    var batch = lifters.slice(i, Math.min(i + BATCH, lifters.length));
    var baseIdx = i;
    var promises = batch.map(function(lifter, j) {
      var idx = baseIdx + j;
      var url = API + '/api/resolve?name=' + encodeURIComponent(lifter.name) + '&gender=' + encodeURIComponent(lifter.gender) + '&source=' + oplSource;
      return fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var best = d.results && d.results[0];
          return { idx: idx, oplName: best ? best.name : '', oplSlug: best ? best.slug : '', confidence: best ? best.confidence : 'none', oplWeightClass: best ? best.weightClass : '', oplTotal: best ? best.total : '', oplGlPoints: best ? (best.glPoints || '') : '', oplSquat: best ? best.squat : '', oplBench: best ? best.bench : '', oplDeadlift: best ? best.deadlift : '', oplFederation: best ? best.federation : '', oplEquipment: best ? best.equipment : '', dataSource: best && best.slug ? oplSource : '' };
        })
        .catch(function() {
          return { idx: idx, oplName: '', oplSlug: '', confidence: 'none', oplWeightClass: '', oplTotal: '', oplGlPoints: '', oplSquat: '', oplBench: '', oplDeadlift: '', oplFederation: '', oplEquipment: '', dataSource: '' };
        });
    });
    var results = await Promise.all(promises);
    for (var k = 0; k < results.length; k++) {
      st.resolved[results[k].idx] = results[k];
    }
    st.resolvedCount = Math.min(i + BATCH, lifters.length);
    render();
  }
}

function startEdit(idx) {
  var r = st.resolved[idx];
  st.editingIdx = idx;
  st.editingUrl = (r && r.oplSlug) ? oplProfileBase() + '/' + r.oplSlug : '';
  st.lookupError = null;
  render();
  setTimeout(function() {
    var el = document.getElementById('eurl-' + idx);
    if (el) { el.focus(); el.select(); }
  }, 0);
}

function cancelEdit() {
  st.editingIdx = -1;
  st.lookupError = null;
  render();
}

function clearMatch(idx) {
  // Explicitly mark this lifter as having no OpenPowerlifting/OpenIPF profile.
  // Used when an auto-match found a different person with the same name.
  st.resolved[idx] = {
    idx: idx, oplName: '', oplSlug: '', confidence: 'cleared',
    oplWeightClass: '', oplTotal: '', oplGlPoints: '', oplSquat: '',
    oplBench: '', oplDeadlift: '', oplFederation: '', oplEquipment: '', dataSource: ''
  };
  st.editingIdx = -1;
  st.lookupError = null;
  st.saved = false;
  render();
}

async function doLookup(idx) {
  var input = document.getElementById('eurl-' + idx);
  var raw = input ? input.value.trim() : '';
  if (!raw) { st.lookupError = 'Paste an OPL URL or slug first'; render(); return; }

  // Extract slug from URL or accept bare slug
  var slug = raw;
  var m = raw.match(/(?:openpowerlifting|openipf)\.org\/u\/([A-Za-z0-9]+)/i);
  if (m) slug = m[1];
  else if (!/^[A-Za-z0-9]+$/.test(raw)) {
    st.lookupError = 'Paste a profile URL or just the slug';
    render();
    return;
  }

  var btn = document.getElementById('elookup-' + idx);
  if (btn) btn.disabled = true;
  st.lookupError = null;
  render();

  try {
    var res = await fetch(API + '/api/lookup?slug=' + encodeURIComponent(slug.toLowerCase()) + '&source=' + oplSource);
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Not found');
    st.resolved[idx] = {
      idx: idx,
      oplName: data.name || slug,
      oplSlug: slug.toLowerCase(),
      confidence: 'manual',
      oplWeightClass: data.weightClass || '',
      oplTotal: data.total || '',
      oplGlPoints: data.glPoints || '',
      oplSquat: data.squat || '',
      oplBench: data.bench || '',
      oplDeadlift: data.deadlift || '',
      oplFederation: data.federation || '',
      oplEquipment: data.equipment || '',
      dataSource: oplSource
    };
    st.editingIdx = -1;
    st.lookupError = null;
    st.saved = false;
    render();
  } catch (err) {
    st.lookupError = err.message || String(err);
    if (btn) btn.disabled = false;
    render();
  }
}

async function doGenerate() {
  var btn = document.getElementById('genbtn');
  if (btn) btn.disabled = true;
  st.genError = null;

  var label = meetLabel();
  var flightMap = {};
  for (var i = 0; i < st.lifters.length; i++) {
    var lifter = st.lifters[i];
    var r = st.resolved[i];
    var f = lifter.flight || '?';
    if (!flightMap[f]) flightMap[f] = [];
    var athlete = { name: lifter.name };
    if (r && r.oplSlug) athlete.slug = r.oplSlug;
    flightMap[f].push(athlete);
  }

  var flights = Object.keys(flightMap).sort();
  var MAX = 10;
  var bundles = [];
  for (var b = 0; b < flights.length; b += MAX) {
    var chunk = flights.slice(b, b + MAX);
    var squads = chunk.map(function(fl) {
      return { name: label + ' - Flight ' + fl, athletes: flightMap[fl] };
    });
    bundles.push({ flights: chunk, squads: squads });
  }

  try {
    var codes = [];
    for (var bi = 0; bi < bundles.length; bi++) {
      var bundle = bundles[bi];
      var res = await fetch(BUNDLE_API + '/bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ squads: bundle.squads })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      codes.push({ code: data.code, flights: bundle.flights });
    }
    st.bundleCodes = codes;
    st.saved = false;
    render();
  } catch (err) {
    st.genError = err.message || String(err);
    if (btn) btn.disabled = false;
    render();
  }
}

var _shareParam = new URLSearchParams(window.location.search).get('share');
if (_shareParam) {
  loadFromShareCode(_shareParam.trim().toUpperCase());
} else {
  render();
}

// ── Optional "Competition Board" theme ─────────────────────────────
function ensureNeoFonts() {
  if (document.getElementById('neo-fonts')) return;
  var l = document.createElement('link');
  l.id = 'neo-fonts'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&display=swap';
  document.head.appendChild(l);
}
function applyTheme(theme) {
  var neo = theme === 'neo';
  document.documentElement.classList.toggle('theme-neo', neo);
  if (neo) ensureNeoFonts();
  var btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = neo ? '● Classic look' : '○ New look';
}
function toggleTheme() {
  var next = (localStorage.getItem('mls_theme') === 'neo') ? 'classic' : 'neo';
  try { localStorage.setItem('mls_theme', next); } catch (e) {}
  applyTheme(next);
}
applyTheme(localStorage.getItem('mls_theme') === 'neo' ? 'neo' : 'classic');
