var API = 'https://myliftsquad-web.gooseyirl.workers.dev';
var BUNDLE_API = 'https://myliftsquad-api.gooseyirl.workers.dev';
var HISTORY_KEY = 'mls_history';
var HISTORY_MAX = 5;
function loadPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch(e) { return fallback; } }
function savePref(key, val) { try { localStorage.setItem(key, val); } catch(e) {} }

// A meet is either an OpenPowerlifting meet or an OpenIPF one, never a mix:
// comparing athletes only means anything if every number came out of the same
// database. So the source lives on the meet (st.source) and travels with it
// through saves and share links. mls_opl_source is only the default for the
// next import — it never overrides the source a meet was built with.
function sourceName(src) {
  return src === 'ipf' ? 'OpenIPF' : 'OpenPowerlifting';
}

// Meets saved before the source moved onto the meet carry it per athlete
// instead; fall back to that, then to the stored preference.
function entrySource(entry) {
  if (entry.source) return entry.source;
  var resolved = entry.resolved || [];
  for (var i = 0; i < resolved.length; i++) {
    if (resolved[i] && resolved[i].dataSource) return resolved[i].dataSource;
  }
  return loadPref('mls_opl_source', 'opl');
}

async function setOplSource(src) {
  if (src === st.source) return;
  var hasMeet = st.phase === 'done' || st.phase === 'resolving';
  if (hasMeet && !confirm('Switching to ' + sourceName(src) +
      ' will re-look up all athletes, which may take a moment. Continue?')) return;

  st.source = src;
  savePref('mls_opl_source', src);
  if (!hasMeet) { render(); return; }

  // Convert the whole meet or nothing — a half-switched squad would put
  // OpenIPF numbers next to OpenPowerlifting ones.
  st.resolved = new Array(st.lifters.length).fill(null);
  st.resolvedCount = 0;
  st.phase = 'resolving';
  render();
  await doResolveAll();
  st.phase = 'done';
  if (st.saved) saveToHistory();
  render();
  backfillBests();
}

function setMetric(m) {
  st.metric = m;
  savePref('mls_metric', m);
  render();
}

function oplProfileBase() {
  return st.source === 'ipf' ? 'https://www.openipf.org/u' : 'https://www.openpowerlifting.org/u';
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch(e) { return []; }
}

function saveToHistory() {
  if (!st.meet || !st.meetId) return;
  var history = getHistory().filter(function(h) { return h.meetId !== st.meetId; });
  history.unshift({ savedAt: new Date().toISOString(), meetId: st.meetId, lcUrl: st.lcUrl, nameOverride: st.nameOverride, meet: st.meet, provider: st.provider, source: st.source, lifters: st.lifters, resolved: st.resolved, bundleCodes: st.bundleCodes });
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
  // Meets saved before IrishPF support came in are all LiftingCast.
  st.provider = entry.provider || 'liftingcast';
  st.source = entrySource(entry);
  st.lifters = entry.lifters;
  st.activeFlight = null;
  st.resolved = entry.resolved;
  st.resolvedCount = entry.resolved.filter(Boolean).length;
  st.bundleCodes = entry.bundleCodes;
  st.editingIdx = -1;
  st.lookupError = null;
  st.error = null;
  st.saved = true;
  render();
  backfillBests();
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
  provider: 'liftingcast',
  lifters: [],
  activeFlight: null,
  resolved: [],
  resolvedCount: 0,
  editingIdx: -1,
  editingUrl: '',
  editCandidates: null,
  editLoading: false,
  searchQuery: '',
  searchResults: null,
  searchLoading: false,
  searchError: null,
  showUrlEntry: false,
  lookupError: null,
  sortCol: null,
  sortDir: 'asc',
  bundleCodes: null,
  error: null,
  saved: false,
  panelMode: null,        // 'athlete' | 'share'
  panelSlug: null,
  panelName: '',
  panelData: null,
  panelLoading: false,
  panelError: null,
  shareCode: null,
  shareLoading: false,
  codesLoading: false,
  shareError: null,
  metric: loadPref('mls_metric', 'total'),
  sortCol: loadPref('mls_sort_col', 'lot') || 'lot',
  sortDir: loadPref('mls_sort_dir', 'asc'),
  // Which database this meet's numbers came from. Seeded from the saved
  // preference, then replaced by the meet's own source once one is loaded.
  source: loadPref('mls_opl_source', 'opl')
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

var LINK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// One profile as a card. Clickable when it is an alternative to switch to;
// static when it is the profile already selected.
function profileCardHtml(c, opts) {
  var confidence = c.confidence || 'none';
  var label = confidence === 'manual' ? 'Manual' : confidence;
  var bclass = confidence === 'high' ? 'bh'
    : confidence === 'medium' ? 'bm'
    : confidence === 'manual' ? 'bmanual'
    : confidence === 'low' ? 'bl' : 'bn';

  var meta = [];
  if (c.weightClass) meta.push(esc(c.weightClass));
  var metric = st.metric === 'gl' ? c.glPoints : c.total;
  if (metric) meta.push(esc(metric) + (st.metric === 'gl' ? ' GL' : ''));
  if (c.federation) meta.push(esc(c.federation));

  var inner = '<span class="cand-main">' +
    '<span class="cand-name">' + esc(c.name || c.slug) + '</span>' +
    '<span class="cand-slug">' + esc(c.slug) + '</span>' +
    '</span>' +
    '<span class="cand-meta">' + meta.join(' · ') + '</span>' +
    '<span class="badge ' + bclass + '">' + esc(label) + '</span>';

  if (opts && opts.onclick) {
    return '<button class="cand" onclick="' + opts.onclick + '">' + inner + '</button>';
  }
  return '<div class="cand cand-selected">' + inner + '</div>';
}

// Edit panel: the profile in use at the top, up to three alternatives under
// it, then a box for pasting a profile URL or slug.
function buildEditPanelBody() {
  var idx = st.editingIdx;
  var lifter = st.lifters[idx];
  var r = st.resolved[idx];
  if (!lifter) return '';

  var html = '<div class="panel-edit">';

  html += '<div class="set-group"><div class="set-label">Selected profile</div>';
  if (r && r.oplSlug) {
    html += profileCardHtml({
      name: r.oplName, slug: r.oplSlug, confidence: r.confidence,
      weightClass: r.oplWeightClass, total: r.oplTotal,
      glPoints: r.oplGlPoints, federation: r.oplFederation
    }, null);
  } else {
    html += '<div class="cand-status">' +
      (r && r.confidence === 'cleared' ? 'Marked as having no profile.' : 'No profile selected yet.') +
      '</div>';
  }
  html += '</div>';

  html += '<div class="set-group"><div class="set-label">Alternatives</div>';
  if (st.editLoading) {
    html += '<div class="cand-status"><span class="badge bp">Searching…</span></div>';
  } else {
    var alts = [];
    var cands = st.editCandidates || [];
    for (var ci = 0; ci < cands.length && alts.length < 3; ci++) {
      if (r && r.oplSlug && cands[ci].slug === r.oplSlug) continue;
      alts.push({ c: cands[ci], ci: ci });
    }
    if (alts.length) {
      html += '<div class="cand-list">';
      for (var ai = 0; ai < alts.length; ai++) {
        html += profileCardHtml(alts[ai].c, { onclick: 'chooseCandidate(' + idx + ',' + alts[ai].ci + ')' });
      }
      html += '</div>';
    } else {
      html += '<div class="cand-status">No other ' +
        sourceName(st.source) + ' profiles match this name.</div>';
    }
  }
  html += '</div>';

  html += '<div class="set-group"><div class="set-label">Search by name</div>';
  html += '<div class="edit-row">';
  html += '<input type="text" id="esearch" class="edit-input" placeholder="Search ' +
    sourceName(st.source) + '…" value="' + esc(st.searchQuery) + '">';
  html += '<button id="esearchbtn" class="btn-sm btn-sm-primary" onclick="doSearch()"' +
    (st.searchLoading ? ' disabled' : '') + '>' + (st.searchLoading ? 'Searching…' : 'Search') + '</button>';
  html += '</div>';
  if (st.searchError) html += '<p class="lookup-err">' + esc(st.searchError) + '</p>';

  if (st.searchLoading) {
    html += '<div class="cand-status"><span class="badge bp">Searching…</span></div>';
  } else if (st.searchResults) {
    if (st.searchResults.length) {
      html += '<div class="cand-list">';
      for (var si = 0; si < st.searchResults.length; si++) {
        html += profileCardHtml(st.searchResults[si], { onclick: 'chooseSearchResult(' + idx + ',' + si + ')' });
      }
      html += '</div>';
    } else {
      html += '<div class="cand-status">Nothing found for “' + esc(st.searchQuery) + '”.</div>';
    }
  }
  html += '</div>';

  if (st.showUrlEntry) {
    html += '<div class="set-group"><div class="set-label">Profile URL or slug</div>';
    html += '<div class="edit-row">';
    html += '<input type="url" id="eurl-' + idx + '" class="edit-input" placeholder="openpowerlifting.org/u/… or slug" value="' + esc(st.editingUrl) + '">';
    html += '<button id="elookup-' + idx + '" class="btn-sm btn-sm-primary" onclick="doLookup(' + idx + ')">Lookup</button>';
    html += '</div>';
    if (st.lookupError) html += '<p class="lookup-err">' + esc(st.lookupError) + '</p>';
    html += '</div>';
  }

  html += '<div class="edit-foot">';
  html += '<div class="cand-actions">';
  html += '<button class="btn-sm btn-sm-ghost" onclick="clearMatch(' + idx + ')" title="Mark as having no ' + sourceName(st.source) + ' profile">No match</button>';
  html += '<button class="btn-sm btn-sm-ghost" onclick="cancelEdit()">Cancel</button>';
  html += '</div>';
  html += '<button class="btn-icon' + (st.showUrlEntry ? ' btn-icon-active' : '') + '" onclick="toggleUrlEntry()" ' +
    'title="Enter a profile URL or slug" aria-label="Enter a profile URL or slug">' + LINK_ICON + '</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function buildTableRows(entries) {
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var lifter = e.lifter;
    var r = st.resolved[e.idx];
    var isEditing = st.editingIdx === e.idx;

    // Editing happens in the slide-out panel; the row just marks itself as the
    // one being edited.
    html += '<div class="lifter-row' + (isEditing ? ' lifter-row-editing' : '') + '">';
    html += '<div class="lifter-col-main">';
    html += '<div class="lifter-row-name">' + esc(lifter.name) + lcCatHtml(lifter) + '</div>';
    html += lcLotLineHtml(lifter);

    if (!r) {
      html += '</div>';
      html += '<div class="lifter-col-right"><span class="badge bp">Resolving…</span></div>';
    } else if (r.oplSlug) {
      html += '<div class="lifter-row-meta">';
      html += '<a class="slug" href="' + oplProfileBase() + '/' + esc(r.oplSlug) + '" target="_blank" rel="noopener">' + esc(r.oplSlug) + '</a>';
      if (r.oplWeightClass) html += '<span class="muted hide-sm"> · </span><span class="opl-past hide-sm" title="Weight class at their most recent ' + sourceName(st.source) + ' meet">' + esc(r.oplWeightClass) + '</span>';
      if (r.oplTotal) html += '<span class="muted hide-sm"> · </span><span class="opl-past total-past hide-sm" title="Best total across all ' + sourceName(st.source) + ' results">' + esc(r.oplTotal) + '</span>';
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
  var tip = 'How well each lifter was matched to a ' + sourceName(st.source) + ' profile:\n\n' +
    '• High — strong match on name and details; very likely correct.\n' +
    '• Medium — probable match; worth a quick check.\n' +
    '• Low — weak match; please verify before sharing.\n' +
    '• Manual — you set this profile by hand.\n' +
    '• None / No match — no ' + sourceName(st.source) + ' profile (e.g. hasn\'t competed).\n\n' +
    'Tap the ✎ pencil on any lifter to correct a match.';
  return '<span class="conf-help" title="' + esc(tip) + '" role="img" aria-label="What do the confidence levels mean?">?</span>';
}

function thSort(label, col) {
  var active = st.sortCol === col;
  var arrow = active ? (st.sortDir === 'asc' ? ' &#8593;' : ' &#8595;') : '';
  return '<button class="sort-btn' + (active ? ' sort-btn-active' : '') + '" onclick="setSort(\'' + col + '\')">' + label + arrow + '</button>';
}

function flightNames() {
  return Object.keys(groupByFlight(st.lifters)).sort();
}

function setFlight(i) {
  st.activeFlight = flightNames()[i];
  render();
}

// Tabs for picking one flight at a time, with a dropdown fallback on phones.
// Also normalises st.activeFlight, so callers can rely on it afterwards.
function buildFlightNav(groups, flights) {
  if (flights.indexOf(st.activeFlight) < 0) st.activeFlight = flights[0];

  // Spread the tabs as evenly as possible over as few rows as will hold them,
  // five per row at most — so eight flights go 4+4 rather than 5+3.
  var rows = Math.max(1, Math.ceil(flights.length / 5));
  var cols = Math.max(1, Math.ceil(flights.length / rows));
  // Few enough to stay legible as tabs even on a phone.
  var few = flights.length <= 3 ? ' few' : '';

  var html = '<div class="flight-tabs' + few + '" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">';
  for (var i = 0; i < flights.length; i++) {
    var f = flights[i];
    html += '<button class="ftab' + (f === st.activeFlight ? ' ftab-active' : '') + '" onclick="setFlight(' + i + ')">';
    html += 'Flight ' + esc(f);
    html += '<span class="ftab-count">' + groups[f].length + '</span>';
    html += '</button>';
  }
  html += '</div>';

  html += '<div class="flight-picker' + few + '">';
  html += '<select class="flight-select" onchange="setFlight(this.selectedIndex)">';
  for (var j = 0; j < flights.length; j++) {
    var fl = flights[j];
    html += '<option' + (fl === st.activeFlight ? ' selected' : '') + '>';
    html += 'Flight ' + esc(fl) + ' (' + groups[fl].length + ' athletes)';
    html += '</option>';
  }
  html += '</select></div>';

  return html;
}

function buildFlightsHTML() {
  var groups = groupByFlight(st.lifters);
  var flights = Object.keys(groups).sort();
  var html = buildFlightNav(groups, flights);
  var entries = groups[st.activeFlight] || [];

  html += '<div class="flight-section">';
  html += '<div class="lifter-list">';
  html += '<div class="lifter-list-header">';
  html += '<div class="lifter-col-main">' + thSort('Lifter', 'name') + '<span style="opacity:.3;margin:0 8px">·</span>' + thSort('Class', 'class') + '<span style="opacity:.3;margin:0 8px">·</span>' + thSort('Lot', 'lot') + '</div>';
  html += '<div class="lifter-col-right" style="display:flex;align-items:center;gap:12px"><span style="font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);display:inline-flex;align-items:center;gap:4px">Confidence' + confHelpHtml() + '</span>' + thSort(st.metric === 'gl' ? 'GL Pts' : 'Total', 'total') + '</div>';
  html += '</div>';
  html += buildTableRows(sortEntries(entries));
  html += '</div></div>';
  return html;
}


function meetLabel() {
  if (st.nameOverride) return st.nameOverride;
  if (!st.meet) return '';
  // IrishPF pages carry a proper competition name; LiftingCast only has a
  // federation and a date.
  if (st.provider === 'irishpf') return st.meet.name;
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

function showPanel() {
  document.getElementById('panel-overlay').classList.add('open');
  document.getElementById('panel').classList.add('open');
  document.body.classList.add('panel-open');
  document.body.style.overflow = 'hidden';
  renderPanel();
}

// There are two ways to pass a meet on — a code the phone app imports, and a
// link that reopens this page — and one panel covers both. They used to be
// separate Code and Share buttons opening the same body, which said nothing
// about which one you wanted.
//
// Codes are minted once and then reused. Pressing Share used to mint a fresh
// set every time, so a code read out to someone a minute earlier quietly
// stopped being the one on screen.
async function openSharePanel() {
  st.panelMode = 'share';
  st.panelSlug = null;
  st.panelName = 'Share this meet';
  st.shareError = null;
  showPanel();
  if (st.bundleCodes && st.bundleCodes.length) return;

  st.codesLoading = true;
  renderPanel();
  try {
    st.bundleCodes = await buildBundleCodes();
    if (st.saved) saveToHistory();
  } catch(err) {
    st.shareError = err.message || String(err);
  }
  st.codesLoading = false;
  if (st.panelMode === 'share') renderPanel();
}

// The link is only created when asked for. It uploads a copy of the meet, so
// there is no reason to make one for someone who only wanted a code to read
// out. Copies to the clipboard once it exists, since that is the only thing
// anyone does with it.
async function createShareLink() {
  if (st.shareCode) { copyShareUrl(); return; }
  st.shareLoading = true;
  st.shareError = null;
  renderPanel();
  try {
    if (!st.bundleCodes || !st.bundleCodes.length) st.bundleCodes = await buildBundleCodes();
    var state = {
      meetId: st.meetId, lcUrl: st.lcUrl, nameOverride: st.nameOverride,
      meet: st.meet, provider: st.provider, source: st.source,
      lifters: st.lifters, resolved: st.resolved,
      bundleCodes: st.bundleCodes
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
    if (st.saved) saveToHistory();
    renderPanel();
    copyShareUrl();
  } catch(err) {
    st.shareError = err.message || String(err);
    st.shareLoading = false;
    renderPanel();
  }
}

function openSettingsPanel() {
  st.panelMode = 'settings';
  st.panelSlug = null;
  st.panelName = 'Settings';
  showPanel();
}

function settingsBodyHtml() {
  function group(title, body) {
    return '<div class="set-group"><div class="set-label">' + title + '</div>' + body + '</div>';
  }
  function arrow(col) {
    return st.sortCol === col ? (st.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  }

  var html = group('Data Source',
    '<div class="src-ctrl">' +
    '<button class="src-opt' + (st.source === 'opl' ? ' active' : '') + '" onclick="setOplSource(\'opl\')">OpenPowerlifting</button>' +
    '<button class="src-opt' + (st.source === 'ipf' ? ' active' : '') + '" onclick="setOplSource(\'ipf\')">OpenIPF</button>' +
    '</div>' +
    '<p class="hint">OpenIPF only includes IPF-affiliated competitions.</p>');

  html += group('Display Metric',
    '<div class="src-ctrl">' +
    '<button class="src-opt' + (st.metric === 'total' ? ' active' : '') + '" onclick="setMetric(\'total\')">Total</button>' +
    '<button class="src-opt' + (st.metric === 'gl' ? ' active' : '') + '" onclick="setMetric(\'gl\')">GL Points</button>' +
    '</div>');

  if (st.saved) {
    html += group('Sort By',
      '<div class="src-ctrl">' +
      '<button class="src-opt' + (st.sortCol === 'lot' ? ' active' : '') + '" onclick="setSort(\'lot\')">Lot' + arrow('lot') + '</button>' +
      '<button class="src-opt' + (st.sortCol === 'name' ? ' active' : '') + '" onclick="setSort(\'name\')">Name' + arrow('name') + '</button>' +
      '<button class="src-opt' + (st.sortCol === 'class' ? ' active' : '') + '" onclick="setSort(\'class\')">Class' + arrow('class') + '</button>' +
      '<button class="src-opt' + (st.sortCol === 'total' ? ' active' : '') + '" onclick="setSort(\'total\')">' + (st.metric === 'gl' ? 'GL Points' : 'Total') + arrow('total') + '</button>' +
      '</div>');
  }

  return html;
}

// Two ways out of here, each labelled with where it lands: a code for the app,
// a link for a browser. Returns HTML only; QR canvases are populated by
// renderShareQRs().
function shareBodyHtml() {
  var html = '<div class="set-group"><div class="set-label">Import into the app</div>';
  if (st.codesLoading) {
    html += '<div class="share-box-hint"><span class="badge bp">Generating codes…</span></div>';
  } else if (st.bundleCodes && st.bundleCodes.length === 1) {
    html += '<div class="share-box-qr" id="share-bundle-qr-' + esc(st.bundleCodes[0].code) + '"></div>';
    html += '<div class="share-box-code">' + esc(st.bundleCodes[0].code) + '</div>';
    html += '<div class="share-box-hint">MyLiftSquad &rarr; Import &rarr; enter this code,<br>or scan the QR with the app</div>';
    html += '<div class="share-box-actions"><button class="btn-copy" id="copybtn" onclick="copyBundleCode()">Copy Code</button></div>';
  } else if (st.bundleCodes && st.bundleCodes.length > 1) {
    // More than ten flights, so they arrive as one code per batch.
    for (var sbi = 0; sbi < st.bundleCodes.length; sbi++) {
      var sbc = st.bundleCodes[sbi];
      html += '<div style="display:flex;align-items:center;gap:10px;width:100%">';
      html += '<span style="color:var(--text-muted);font-size:.8rem;flex:1">Flights ' + esc(sbc.flights.join(', ')) + '</span>';
      html += '<span class="share-box-code" style="font-size:1.3rem">' + esc(sbc.code) + '</span>';
      html += '<div class="share-box-qr" id="share-bundle-qr-' + esc(sbc.code) + '" style="padding:4px"></div>';
      html += '</div>';
    }
    html += '<div class="share-box-hint">MyLiftSquad &rarr; Import &rarr; enter a code, or scan its QR</div>';
  } else {
    html += '<div class="share-box-hint">No import codes for this meet.</div>';
  }
  html += '</div>';

  html += '<div class="set-group"><div class="set-label">Send a link</div>';
  html += '<div class="share-box-hint">Opens this page in a browser, with every match as you have it here.</div>';
  if (st.shareLoading) {
    html += '<div class="share-box-hint"><span class="badge bp">Creating link…</span></div>';
  } else {
    if (st.shareCode) html += '<div class="share-url">' + esc(shareUrl()) + '</div>';
    html += '<div class="share-box-actions"><button id="copyurlbtn" class="btn-copy-link" onclick="createShareLink()">' +
      (st.shareCode ? 'Copy Link' : 'Create Link') + '</button></div>';
  }
  html += '</div>';

  if (st.shareError) html += '<div class="err-box" style="width:100%">' + esc(st.shareError) + '</div>';
  html += '<div class="share-box-expiry">Codes and links expire after 30 days.</div>';
  return html;
}

function renderShareQRs() {
  if (!st.bundleCodes || typeof QRCode === 'undefined') return;
  for (var sqi = 0; sqi < st.bundleCodes.length; sqi++) {
    var sqCode = st.bundleCodes[sqi].code;
    var sqEl = document.getElementById('share-bundle-qr-' + sqCode);
    if (sqEl && !sqEl.hasChildNodes()) {
      var sqSize = st.bundleCodes.length === 1 ? 160 : 80;
      new QRCode(sqEl, { text: sqCode, width: sqSize, height: sqSize, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    }
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

function copyBundleCode() {
  if (!st.bundleCodes || !st.bundleCodes.length) return;
  navigator.clipboard.writeText(st.bundleCodes[0].code).then(function() {
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
    st.provider = s.provider || 'liftingcast';
    // The sender's source, not the recipient's preference — otherwise their
    // cards and their history panels would read different databases.
    st.source = entrySource(s);
    st.bundleCodes = s.bundleCodes || null;
    st.activeFlight = null;
    st.saved = true;
    st.shareCode = null;
    // Keep the shared meet so the recipient can come back to it from Saved
    // Meets without the link. The Codes button in the header reaches the
    // import codes, so the panel doesn't need to open over the entry list.
    saveToHistory();
    render();
    backfillBests();
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
  st.panelMode = 'athlete';
  st.panelSlug = slug;
  st.panelName = name;
  st.panelData = null;
  st.panelLoading = true;
  st.panelError = null;
  document.getElementById('panel-overlay').classList.add('open');
  document.getElementById('panel').classList.add('open');
  document.body.classList.add('panel-open');
  document.body.style.overflow = 'hidden';
  renderPanel();
  fetchPanelData(slug);
}

function closePanel() {
  document.getElementById('panel-overlay').classList.remove('open');
  document.getElementById('panel').classList.remove('open');
  document.body.classList.remove('panel-open');
  document.body.style.overflow = '';
  var wasEditing = st.panelMode === 'edit';
  st.panelMode = null;
  if (wasEditing) {
    closeEdit();
    // Redraw so the edited row drops its highlight and shows the new match.
    render();
  }
}

async function fetchPanelData(slug) {
  try {
    var res = await fetch(API + '/api/lifter?slug=' + encodeURIComponent(slug) + '&source=' + st.source);
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
  if (st.panelSlug) html += '<a class="panel-opl" href="' + oplProfileBase() + '/' + esc(st.panelSlug) + '" target="_blank" rel="noopener">' + sourceName(st.source) + ' &#8599;</a>';
  html += '<button class="panel-close" onclick="closePanel()">&#10005;</button>';
  html += '</div></div>';
  if (st.panelMode === 'settings') {
    html += '<div class="panel-settings">' + settingsBodyHtml() + '</div>';
    el.innerHTML = html;
    return;
  }
  if (st.panelMode === 'edit') {
    html += buildEditPanelBody();
    el.innerHTML = html;
    bindEditPanelInputs();
    return;
  }
  if (st.panelMode === 'share') {
    // Each section carries its own loading and error state, so the panel no
    // longer blanks out while one half of it is working.
    html += '<div class="panel-share">' + shareBodyHtml() + '</div>';
    el.innerHTML = html;
    renderShareQRs();
    return;
  }
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
    if (parts.length) html += '<div class="ath-meta" title="Best results across all ' + sourceName(st.source) + ' competitions"><span class="ath-past-tag">Past PB</span>' + parts.join('<span class="ath-sep"> - </span>') + '</div>';
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
  var html = buildFlightNav(groups, flights);
  var entries = sortEntries(groups[st.activeFlight] || []);

  html += '<div class="flight-section">';
  for (var i = 0; i < entries.length; i++) {
    html += buildAthleteCard(entries[i].lifter, st.resolved[entries[i].idx]);
  }
  html += '</div>';
  return html;
}

function doSave() {
  var nie = document.getElementById('nom-edit');
  if (nie) st.nameOverride = nie.value.trim();
  // Keep the edited title, but never let it be saved blank.
  var mne = document.getElementById('meet-name-edit');
  if (mne && mne.value.trim() && st.meet) st.meet.name = mne.value.trim();
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
      '<div class="card-title">Competition</div>' +
      '<div class="fg"><label for="lcu">LiftingCast or IrishPF URL</label>' +
      '<input type="url" id="lcu" placeholder="https://liftingcast.com/meets/…" value="' + esc(st.lcUrl) + '">' +
      '<p class="hint">A LiftingCast meet link, or an IrishPF competition page such as irishpowerliftingfederation.com/august-open-2026/</p></div>' +
      '<div class="fg"><label for="nom">Competition name <span style="opacity:.5">(optional)</span></label>' +
      '<input type="text" id="nom" placeholder="e.g. IrishPF 2026 June Open" value="' + esc(st.nameOverride) + '">' +
      '<p class="hint">Squad names will be prefixed with this. Defaults to the competition name on IrishPF, or federation + date from LiftingCast.</p></div>' +
      '<div class="fg"><label>Data Source</label>' +
      '<div class="src-ctrl">' +
      '<button class="src-opt' + (st.source === 'opl' ? ' active' : '') + '" id="src-opl" data-src="opl" onclick="setOplSource(this.dataset.src)">OpenPowerlifting</button>' +
      '<button class="src-opt' + (st.source === 'ipf' ? ' active' : '') + '" id="src-ipf" data-src="ipf" onclick="setOplSource(this.dataset.src)">OpenIPF</button>' +
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
    if (st.phase === 'done' && !st.saved) {
      html += '<input type="text" id="meet-name-edit" class="meet-name-input" value="' + esc(meet.name) + '" aria-label="Competition title">';
    } else {
      html += '<span class="meet-name">' + esc(meet.name) + '</span>';
    }
    if (st.phase === 'done') {
      // One right-aligned group so the actions line up as a uniform set.
      html += '<div class="meet-actions">';
      if (st.saved) {
        // One button for both a code and a link — including for share-link
        // recipients, who arrive saved and have no other route to the codes.
        html += '<button class="btn-act btn-share" onclick="openSharePanel()">Share</button>';
        html += '<button class="btn-act btn-edit" onclick="st.saved=false;st.shareCode=null;render()">Edit</button>';
      } else {
        html += '<button class="btn-act btn-save" onclick="doSave()">Save</button>';
      }
      html += '<button class="btn-act btn-settings" onclick="openSettingsPanel()">Settings</button>';
      html += '</div>';
    }
    html += '</div>';
    // Codes, QRs and the share link render in the slide-out panel (see
    // openSharePanel / renderPanel), not inline, so they no longer push the
    // page down.
    if (st.phase === 'resolving') {
      var pct = st.lifters.length > 0 ? Math.round(st.resolvedCount / st.lifters.length * 100) : 0;
      html += '<div class="prog-wrap">';
      html += '<div class="prog-bg"><div class="prog-fill" style="width:' + pct + '%"></div></div>';
      html += '<p class="prog-label">Resolving ' + sourceName(st.source) + ' slugs… ' + st.resolvedCount + ' / ' + st.lifters.length + '</p>';
      html += '</div>';
    } else if (st.saved) {
      html += '<p class="hint" style="margin-top:8px">Squad prefix: <strong>' + esc(meetLabel()) + '</strong></p>';
    } else {
      // Edit mode: let the user change the squad prefix (name override).
      // With no override, IrishPF meets fall back to the (editable) title and
      // LiftingCast ones to federation + date.
      var irish = st.provider === 'irishpf';
      var defLabel = !st.meet ? '' : irish ? st.meet.name : st.meet.federation + ' - ' + st.meet.date;
      html += '<div class="fg" style="margin-top:10px"><label for="nom-edit">Squad prefix <span style="opacity:.5">(optional)</span></label>';
      html += '<input type="text" id="nom-edit" placeholder="' + esc(defLabel) + '" value="' + esc(st.nameOverride) + '">';
      html += '<p class="hint">Squad names will be prefixed with this. Defaults to ' + (irish ? 'the competition title above' : 'federation + date') + '.</p></div>';
    }
    // Meet tags sit under the squad prefix rather than crowding the title.
    html += '<div class="meet-chips">';
    html += '<span class="chip">' + esc(meet.federation) + '</span>';
    if (meet.date) html += '<span class="chip">' + esc(meet.date) + '</span>';
    html += '<span class="chip ' + (st.source === 'ipf' ? 'chip-ipf' : 'chip-opl') + '">' + sourceName(st.source) + '</span>';
    html += '</div>';
    html += '</div>';

    if (st.saved) {
      html += buildSquadView();
    } else {
      html += buildFlightsHTML();
    }

    if (st.phase === 'done') {
      if (!st.saved) {
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
        // Same panel as the header's Share button, so there is one place codes
        // and links come from whether the meet has been saved yet or not.
        html += '<button class="btn btn-primary btn-block" onclick="openSharePanel()">Share this meet</button>';
        html += '</div>';
      }
    }

  } else if (st.phase === 'error') {
    html = '<div class="err-box">' + esc(st.error) + '</div>' +
      '<button class="btn btn-secondary" onclick="doReset()">Try again</button>';
  }

  app.innerHTML = html;

  // Import codes and their QRs render inside the slide-out panel, via
  // renderShareQRs(). Keep an open settings panel in step with toggles made
  // from within it, since those re-render the page but not the panel.
  if (st.panelMode === 'settings') renderPanel();

  if (st.phase === 'input') {
    var ui = document.getElementById('lcu');
    var ni = document.getElementById('nom');
    if (ui) {
      ui.addEventListener('input', function() { st.lcUrl = this.value; });
      ui.addEventListener('keydown', function(e) { if (e.key === 'Enter') doFetch(); });
    }
    if (ni) ni.addEventListener('input', function() { st.nameOverride = this.value; });
  }

  // Edit-mode squad-prefix field (shown in the done view before saving).
  var nie = document.getElementById('nom-edit');
  if (nie) nie.addEventListener('input', function() { st.nameOverride = this.value.trim(); });

  // Edit-mode competition title. Updated as you type, but not re-rendered —
  // that would blur the field mid-edit.
  var mne = document.getElementById('meet-name-edit');
  if (mne) mne.addEventListener('input', function() {
    if (st.meet) st.meet.name = this.value;
  });
}

function doReset() {
  st.phase = 'input';
  st.error = null;
  st.bundleCodes = null;
  st.saved = false;
  // Back to a blank import, so the next meet starts from the user's own
  // default rather than inheriting the source of the meet they just closed.
  st.source = loadPref('mls_opl_source', 'opl');
  render();
}

async function doFetch() {
  var ui = document.getElementById('lcu');
  var ni = document.getElementById('nom');
  if (ui) st.lcUrl = ui.value.trim();
  if (ni) st.nameOverride = ni.value.trim();
  if (!st.lcUrl) { alert('Please enter a LiftingCast or IrishPF URL'); return; }

  st.phase = 'fetching';
  st.error = null;
  st.bundleCodes = null;
  render();

  try {
    var res = await fetch(API + '/api/meet?url=' + encodeURIComponent(st.lcUrl));
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

    st.meet = data.meet;
    st.meetId = data.meetId;
    st.provider = data.provider || 'liftingcast';
    st.lifters = data.lifters;
    st.activeFlight = null;
    st.resolved = new Array(data.lifters.length).fill(null);
    st.resolvedCount = 0;
    st.phase = 'resolving';
    render();

    await doResolveAll();
    st.phase = 'done';
    st.saved = false;
    render();
    backfillBests();
  } catch (err) {
    st.phase = 'error';
    st.error = err.message || String(err);
    render();
  }
}

// Bumped when the shape of a card's numbers changes, so stored meets can be
// spotted and topped up rather than silently showing stale figures.
var BESTS_VERSION = 2;
var backfillToken = 0;

// Cards built before this version hold one meet's numbers — the lifter's best
// day by GL points — instead of their best squat, bench, deadlift and total,
// which are usually spread across different meets. /api/lookup reads the whole
// competition history, so it can put that right for meets already saved or
// shared. Also covers a page deployed ahead of the API, where a fresh resolve
// comes back without bests.
async function backfillBests() {
  var token = ++backfillToken;
  var source = st.source;
  var todo = [];
  for (var i = 0; i < st.resolved.length; i++) {
    var r = st.resolved[i];
    if (r && r.oplSlug && r.bestsV !== BESTS_VERSION) todo.push(i);
  }
  if (!todo.length) return;

  var BATCH = 5;
  for (var b = 0; b < todo.length; b += BATCH) {
    await Promise.all(todo.slice(b, b + BATCH).map(function(idx) {
      var slug = st.resolved[idx].oplSlug;
      return fetch(API + '/api/lookup?slug=' + encodeURIComponent(slug) + '&source=' + source)
        .then(function(res) { return res.ok ? res.json() : null; })
        .then(function(data) {
          // The meet may have been closed, or its source switched, in flight.
          if (!data || token !== backfillToken) return;
          var r = st.resolved[idx];
          if (!r || r.oplSlug !== slug) return;
          // An athlete whose every result was a DQ has no bests to show; keep
          // what is already on the card rather than blanking it.
          if (data.total || data.squat || data.bench || data.deadlift || data.glPoints) {
            r.oplWeightClass = data.weightClass || '';
            r.oplTotal = data.total || '';
            r.oplGlPoints = data.glPoints || '';
            r.oplSquat = data.squat || '';
            r.oplBench = data.bench || '';
            r.oplDeadlift = data.deadlift || '';
            r.oplFederation = data.federation || '';
            r.oplEquipment = data.equipment || '';
            r.dataSource = source;
          }
          // An API that predates bests leaves this unstamped, so the next load
          // tries again rather than settling for the numbers it just returned.
          r.bestsV = data.bests ? BESTS_VERSION : 0;
        })
        .catch(function() {});
    }));
    if (token !== backfillToken) return;
    render();
  }
  if (st.saved) saveToHistory();
}

async function doResolveAll() {
  var lifters = st.lifters;
  var BATCH = 5;
  for (var i = 0; i < lifters.length; i += BATCH) {
    var batch = lifters.slice(i, Math.min(i + BATCH, lifters.length));
    var baseIdx = i;
    var promises = batch.map(function(lifter, j) {
      var idx = baseIdx + j;
      var url = API + '/api/resolve?name=' + encodeURIComponent(lifter.name) + '&gender=' + encodeURIComponent(lifter.gender) + '&source=' + st.source;
      return fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var best = d.results && d.results[0];
          return { idx: idx, oplName: best ? best.name : '', oplSlug: best ? best.slug : '', confidence: best ? best.confidence : 'none', oplWeightClass: best ? best.weightClass : '', oplTotal: best ? best.total : '', oplGlPoints: best ? (best.glPoints || '') : '', oplSquat: best ? best.squat : '', oplBench: best ? best.bench : '', oplDeadlift: best ? best.deadlift : '', oplFederation: best ? best.federation : '', oplEquipment: best ? best.equipment : '', dataSource: best && best.slug ? st.source : '', bestsV: best && best.bests ? BESTS_VERSION : 0 };
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

// /api/candidates walks every search hit, so people sharing a name (David
// Walsh #1/#2/#3) all come back. Falls back to the resolver's shortlist if the
// API predates that endpoint, so this page can deploy on its own.
async function fetchCandidates(lifter) {
  var qs = 'name=' + encodeURIComponent(lifter.name) +
    '&gender=' + encodeURIComponent(lifter.gender || 'MALE') + '&source=' + st.source;
  try {
    var res = await fetch(API + '/api/candidates?' + qs + '&limit=5');
    // An empty list is a real answer — only a missing endpoint falls through,
    // otherwise a search for someone who isn't on OPL returns fuzzy noise.
    if (res.ok) {
      var data = await res.json();
      return data.results || [];
    }
  } catch (e) { /* fall through */ }
  try {
    var fallback = await fetch(API + '/api/resolve?' + qs);
    var fallbackData = await fallback.json();
    return fallbackData.results || [];
  } catch (e) {
    return [];
  }
}

// Editing slides out a panel with the current profile, the alternatives and a
// URL box, so correcting a match is a click rather than a hunt for a URL.
async function startEdit(idx) {
  st.editingIdx = idx;
  st.editingUrl = '';
  st.lookupError = null;
  st.editCandidates = null;
  st.editLoading = true;
  st.panelMode = 'edit';
  st.panelSlug = null;
  st.panelName = st.lifters[idx] ? st.lifters[idx].name : 'Edit match';
  render();
  showPanel();

  var candidates = await fetchCandidates(st.lifters[idx]);
  // The panel may have been closed, or another athlete opened, in the meantime.
  if (st.editingIdx !== idx || st.panelMode !== 'edit') return;
  st.editCandidates = candidates;
  st.editLoading = false;
  renderPanel();
}

// The panel is rebuilt on every state change, so its fields keep their value
// in state rather than in the DOM.
function bindEditPanelInputs() {
  var search = document.getElementById('esearch');
  if (search) {
    search.addEventListener('input', function() { st.searchQuery = this.value; });
    search.addEventListener('keydown', function(e) { if (e.key === 'Enter') doSearch(); });
  }
  var url = document.getElementById('eurl-' + st.editingIdx);
  if (url) {
    url.addEventListener('input', function() { st.editingUrl = this.value; });
    url.addEventListener('keydown', function(e) { if (e.key === 'Enter') doLookup(st.editingIdx); });
  }
}

function toggleUrlEntry() {
  st.showUrlEntry = !st.showUrlEntry;
  st.lookupError = null;
  renderPanel();
  if (st.showUrlEntry) {
    var el = document.getElementById('eurl-' + st.editingIdx);
    if (el) el.focus();
  }
}

// Free-text search, for when the entry list name doesn't match the profile
// name — married names, initials, transliterations.
async function doSearch() {
  var input = document.getElementById('esearch');
  var q = (input ? input.value : st.searchQuery || '').trim();
  st.searchQuery = q;
  if (!q) {
    st.searchError = 'Type a name to search for';
    st.searchResults = null;
    renderPanel();
    return;
  }

  var idx = st.editingIdx;
  var lifter = st.lifters[idx];
  st.searchError = null;
  st.searchResults = null;
  st.searchLoading = true;
  renderPanel();

  var results = await fetchCandidates({ name: q, gender: lifter ? lifter.gender : 'MALE' });
  // Bail if the panel moved on to another athlete while this was in flight.
  if (st.editingIdx !== idx || st.panelMode !== 'edit') return;
  st.searchResults = results;
  st.searchLoading = false;
  renderPanel();
}

function chooseSearchResult(idx, si) {
  var c = st.searchResults && st.searchResults[si];
  if (c) applyProfile(idx, c);
}

function chooseCandidate(idx, ci) {
  var c = st.editCandidates && st.editCandidates[ci];
  if (c) applyProfile(idx, c);
}

function applyProfile(idx, c) {
  st.resolved[idx] = {
    idx: idx,
    oplName: c.name || '',
    oplSlug: c.slug || '',
    // Picked by a human, so it outranks whatever the name match scored.
    confidence: 'manual',
    oplWeightClass: c.weightClass || '',
    oplTotal: c.total || '',
    oplGlPoints: c.glPoints || '',
    oplSquat: c.squat || '',
    oplBench: c.bench || '',
    oplDeadlift: c.deadlift || '',
    oplFederation: c.federation || '',
    oplEquipment: c.equipment || '',
    dataSource: st.source,
    bestsV: c.bests ? BESTS_VERSION : 0
  };
  st.saved = false;
  closePanel();
}

function closeEdit() {
  st.editingIdx = -1;
  st.editCandidates = null;
  st.editLoading = false;
  st.searchQuery = '';
  st.searchResults = null;
  st.searchLoading = false;
  st.searchError = null;
  st.showUrlEntry = false;
  st.editingUrl = '';
  st.lookupError = null;
}

function cancelEdit() {
  closePanel();
}

function clearMatch(idx) {
  // Explicitly mark this lifter as having no OpenPowerlifting/OpenIPF profile.
  // Used when an auto-match found a different person with the same name.
  st.resolved[idx] = {
    idx: idx, oplName: '', oplSlug: '', confidence: 'cleared',
    oplWeightClass: '', oplTotal: '', oplGlPoints: '', oplSquat: '',
    oplBench: '', oplDeadlift: '', oplFederation: '', oplEquipment: '', dataSource: ''
  };
  st.saved = false;
  closePanel();
}

async function doLookup(idx) {
  var input = document.getElementById('eurl-' + idx);
  var raw = input ? input.value.trim() : '';
  // Held in state so re-rendering the panel doesn't discard what was typed.
  st.editingUrl = raw;
  if (!raw) { st.lookupError = 'Paste an OPL URL or slug first'; renderPanel(); return; }

  // Extract slug from URL or accept bare slug
  var slug = raw;
  var m = raw.match(/(?:openpowerlifting|openipf)\.org\/u\/([A-Za-z0-9]+)/i);
  if (m) slug = m[1];
  else if (!/^[A-Za-z0-9]+$/.test(raw)) {
    st.lookupError = 'Paste a profile URL or just the slug';
    renderPanel();
    return;
  }

  var btn = document.getElementById('elookup-' + idx);
  if (btn) btn.disabled = true;
  st.lookupError = null;

  try {
    var res = await fetch(API + '/api/lookup?slug=' + encodeURIComponent(slug.toLowerCase()) + '&source=' + st.source);
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
      dataSource: st.source,
      bestsV: data.bests ? BESTS_VERSION : 0
    };
    st.saved = false;
    closePanel();
  } catch (err) {
    st.lookupError = err.message || String(err);
    if (btn) btn.disabled = false;
    renderPanel();
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
  l.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap';
  document.head.appendChild(l);
}
var SUN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/>' +
  '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2' +
  'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

var MOON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function applyTheme(theme) {
  var neo = theme === 'neo';
  document.documentElement.classList.toggle('theme-neo', neo);
  if (neo) ensureNeoFonts();
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  // Show the mode the button switches to: a moon while light, a sun while dark.
  btn.innerHTML = neo ? MOON_ICON : SUN_ICON;
  var label = neo ? 'Switch to dark mode' : 'Switch to light mode';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
function toggleTheme() {
  var next = (localStorage.getItem('mls_theme') === 'neo') ? 'classic' : 'neo';
  try { localStorage.setItem('mls_theme', next); } catch (e) {}
  applyTheme(next);
}
applyTheme(localStorage.getItem('mls_theme') === 'neo' ? 'neo' : 'classic');
