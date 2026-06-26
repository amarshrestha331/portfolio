/* App state */
let tests = [];
let filter = 'all';
let search = '';
let pageSize = 10;
let currentPage = 1;
let charts = { pie: null, bar: null, failure: null };

/* DOM */
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const loadingState = document.getElementById('loadingState');
const loadingMessage = document.getElementById('loadingMessage');
const progressBar = document.getElementById('progressBar');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const uploadSection = document.getElementById('uploadSection');
const dashboardSection = document.getElementById('dashboardSection');
const resetBtn = document.getElementById('resetBtn');
const searchInput = document.getElementById('searchInput');
const testTableBody = document.getElementById('testTableBody');
const emptyTable = document.getElementById('emptyTable');
const detailModal = document.getElementById('detailModal');
const modalTitle = document.getElementById('modalTitle');
const modalContent = document.getElementById('modalContent');

/* ---------- Direct trace loading via postMessage ----------
 * trace.playwright.dev listens for window.postMessage({ method: 'load',
 * params: { trace: Blob } }, '*'). Blobs are structured-cloneable across
 * origins, so the embedded iframe can receive the trace data directly.
 * No service worker needed.
 */
function loadTraceIntoIframe(iframe, blob) {
  if (!iframe.contentWindow) return;
  const send = () => {
    try {
      iframe.contentWindow.postMessage({ method: 'load', params: { trace: blob } }, '*');
    } catch (e) {
      console.warn('[trace] postMessage failed:', e);
    }
  };
  // The handler is registered when the React app mounts, which happens after
  // the load event. Send a few times to cover the race.
  send();
  setTimeout(send, 200);
  setTimeout(send, 800);
}

/* ---------- Upload wiring ---------- */
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('border-brand', 'bg-brand-tint'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-brand', 'bg-brand-tint'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('border-brand', 'bg-brand-tint');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

resetBtn.addEventListener('click', () => {
  tests = [];
  fileInput.value = '';
  resetFilterState();
  dashboardSection.classList.add('hidden');
  resetBtn.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  dropZone.classList.remove('hidden');
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
});

function resetFilterState() {
  filter = 'all';
  search = '';
  searchInput.value = '';
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });
}

async function handleFile(file) {
  const isZip  = /\.zip$/i.test(file.name);
  const isHtml = /\.html?$/i.test(file.name);
  if (!isZip && !isHtml) {
    showError('Please upload a .zip archive or a Playwright index.html report.');
    return;
  }
  dropZone.classList.add('hidden');
  errorState.classList.add('hidden');
  loadingState.classList.remove('hidden');

  const progress = (msg, pct) => {
    loadingMessage.textContent = msg;
    progressBar.style.width = `${Math.round(pct * 100)}%`;
  };

  try {
    const result = isHtml
      ? await parseHtmlFile(file, progress)
      : await parseZip(file, progress);
    tests = result.tests;
    if (!tests.length) throw new Error('No tests found. Expected a Playwright JSON report, HTML report, or test-results/ folder.');
    resetFilterState();
    renderDashboard(result.warning, result.meta);
  } catch (err) {
    console.error(err);
    showError(err.message || 'Unknown error parsing file.');
  } finally {
    loadingState.classList.add('hidden');
  }
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorState.classList.remove('hidden');
  dropZone.classList.remove('hidden');
}

/* ---------- Dashboard rendering ---------- */
function renderDashboard(warning, meta) {
  uploadSection.classList.add('hidden');
  dashboardSection.classList.remove('hidden');
  resetBtn.classList.remove('hidden');

  const banner = document.getElementById('warningBanner');
  if (warning) {
    document.getElementById('warningMessage').textContent = warning;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  renderMetaBar(meta);

  const counts = countByStatus(tests);
  document.getElementById('statTotal').textContent = tests.length;
  document.getElementById('statPassed').textContent = counts.passed;
  document.getElementById('statFailed').textContent = counts.failed;
  document.getElementById('statFlaky').textContent = counts.flaky;
  document.getElementById('statSkipped').textContent = counts.skipped;
  const eligible = tests.length - counts.skipped;
  const passRate = eligible ? ((counts.passed / eligible) * 100).toFixed(1) : '0';
  document.getElementById('statPassRate').textContent = `${passRate}%`;

  renderCharts(counts);
  renderTable();
  renderClustersPanel();
  renderSlowestStepsPanel();
}

/* ---------- Failure clustering (Jaccard on token sets) ---------- */
function renderClustersPanel() {
  const panel = document.getElementById('clustersPanel');
  const body = document.getElementById('clustersBody');
  if (!panel || !body) return;
  const failing = tests.filter(t => (t.status === 'failed' || t.status === 'flaky') && t.errorMessage);
  if (failing.length < 2) { panel.classList.add('hidden'); return; }
  const clusters = clusterByError(failing);
  if (!clusters.some(c => c.members.length >= 2)) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  body.innerHTML = clusters
    .filter(c => c.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length)
    .map((cluster, i) => `
      <details class="cluster" ${i === 0 ? 'open' : ''}>
        <summary>
          <span class="cluster-count">${cluster.members.length}</span>
          <span class="cluster-canonical">${escapeHtml(cluster.canonical)}</span>
        </summary>
        <ul class="cluster-members">
          ${cluster.members.map(m => `
            <li><button class="link-btn" data-test-id="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button> <span class="text-slate-400 text-xs">${escapeHtml(m.file)}</span></li>
          `).join('')}
        </ul>
      </details>
    `).join('');

  body.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = tests.find(x => x.id === btn.dataset.testId);
      if (t) openDetail(t);
    });
  });
}

function clusterByError(failing) {
  const items = failing.map(t => ({
    id: t.id, name: t.name, file: t.file || '',
    raw: t.errorMessage, tokens: tokenizeError(t.errorMessage),
  }));
  const clusters = [];
  const THRESHOLD = 0.5;
  for (const it of items) {
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < clusters.length; i++) {
      const score = jaccard(it.tokens, clusters[i].tokens);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestScore >= THRESHOLD) clusters[bestIdx].members.push(it);
    else clusters.push({ canonical: firstLine(it.raw), tokens: it.tokens, members: [it] });
  }
  return clusters;
}

function tokenizeError(msg) {
  const cleaned = (msg || '')
    .toLowerCase()
    .replace(/\b\d+(ms|s|m|h)?\b/g, '#NUM')
    .replace(/\b0x[0-9a-f]+\b/g, '#HEX')
    .replace(/['"][^'"]{0,40}['"]/g, '#STR')
    .replace(/at [^\n]+:\d+:\d+/g, '')
    .replace(/[^a-z0-9_#]+/g, ' ');
  return new Set(cleaned.split(/\s+/).filter(t => t.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function firstLine(s) { return (s || '').split('\n').find(l => l.trim()) || '(no error message)'; }

/* ---------- Slowest steps panel ---------- */
function renderSlowestStepsPanel() {
  const panel = document.getElementById('slowestPanel');
  const body = document.getElementById('slowestBody');
  if (!panel || !body) return;
  const flat = [];
  for (const t of tests) {
    const last = (t.attempts || []).slice(-1)[0];
    walkSteps(last?.steps || [], (step) => {
      if (!step.duration || step.duration < 200) return;
      if ((step.steps || []).length) return; // leaf only
      flat.push({ step, test: t });
    });
  }
  if (!flat.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  flat.sort((a, b) => b.step.duration - a.step.duration);
  const top = flat.slice(0, 15);
  const max = top[0].step.duration;

  body.innerHTML = top.map(({ step, test }) => `
    <button class="slow-step-row link-btn" data-test-id="${escapeHtml(test.id)}">
      <span class="slow-step-title">${escapeHtml(step.title || '')}</span>
      <span class="slow-step-test">${escapeHtml(test.name)}</span>
      <span class="slow-step-bar"><span style="width:${(step.duration / max * 100).toFixed(1)}%"></span></span>
      <span class="slow-step-dur">${formatDuration(step.duration)}</span>
    </button>
  `).join('');

  body.querySelectorAll('.slow-step-row').forEach(row => {
    row.addEventListener('click', () => {
      const t = tests.find(x => x.id === row.dataset.testId);
      if (t) openDetail(t);
    });
  });
}

function walkSteps(steps, fn) {
  for (const s of steps || []) { fn(s); walkSteps(s.steps, fn); }
}

function renderMetaBar(meta) {
  const bar = document.getElementById('metaBar');
  if (!meta || (!meta.startTime && !meta.duration)) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  document.getElementById('metaStartTime').textContent = formatStartTime(meta.startTime);
  document.getElementById('metaDuration').textContent = formatExecutionTime(meta.duration);
}

function formatStartTime(value) {
  if (!value) return '';
  const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : value;
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatExecutionTime(ms) {
  if (!ms || ms < 0) return '';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function countByStatus(list) {
  const c = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const t of list) {
    if (c[t.status] !== undefined) c[t.status]++;
  }
  return c;
}

/* ---------- Charts ---------- */
function renderCharts(counts) {
  const colors = {
    passed:  '#32CF74', // brand
    failed:  '#ef4444',
    flaky:   '#f59e0b',
    skipped: '#94a3b8',
  };
  const statusLabels = ['Passed', 'Failed', 'Flaky', 'Skipped'];
  const statusKeys = ['passed', 'failed', 'flaky', 'skipped'];
  const statusData = [counts.passed, counts.failed, counts.flaky, counts.skipped];

  const onSliceClick = (e, elements) => {
    if (!elements?.length) return;
    const idx = elements[0].index;
    if (statusData[idx] > 0) applyFilter(statusKeys[idx], { scroll: true });
  };
  const onSliceHover = (e, elements) => {
    e.native.target.style.cursor = elements?.length && statusData[elements[0].index] > 0 ? 'pointer' : 'default';
  };

  destroyChart('pie');
  charts.pie = new Chart(document.getElementById('pieChart'), {
    type: 'doughnut',
    data: {
      labels: statusLabels,
      datasets: [{
        data: statusData,
        backgroundColor: [colors.passed, colors.failed, colors.flaky, colors.skipped],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 11, family: 'Arial, Helvetica, sans-serif' } } } },
      onClick: onSliceClick,
      onHover: onSliceHover,
    },
  });

  destroyChart('bar');
  charts.bar = new Chart(document.getElementById('barChart'), {
    type: 'bar',
    data: {
      labels: statusLabels,
      datasets: [{
        data: statusData,
        backgroundColor: [colors.passed, colors.failed, colors.flaky, colors.skipped],
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      onClick: onSliceClick,
      onHover: onSliceHover,
    },
  });

  // Failure categories
  const cats = {};
  for (const t of tests) {
    if (t.status === 'failed' || t.status === 'flaky') {
      const c = t.failureCategory || 'Other';
      cats[c] = (cats[c] || 0) + 1;
    }
  }
  const labels = Object.keys(cats);
  const data = labels.map(l => cats[l]);

  destroyChart('failure');
  charts.failure = new Chart(document.getElementById('failureChart'), {
    type: 'bar',
    data: {
      labels: labels.length ? labels : ['No failures'],
      datasets: [{
        data: labels.length ? data : [0],
        backgroundColor: '#ef4444',
        borderRadius: 8,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

/* ---------- Table ---------- */
function renderTable() {
  const filtered = tests.filter(t => {
    if (filter !== 'all' && t.status !== filter) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  testTableBody.innerHTML = '';
  const paginationBar = document.getElementById('paginationBar');

  if (!filtered.length) {
    emptyTable.classList.remove('hidden');
    if (paginationBar) paginationBar.classList.add('hidden');
    return;
  }
  emptyTable.classList.add('hidden');

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  for (const t of pageRows) {
    const evidenceHtml = [];
    if (t.screenshots.length) evidenceHtml.push(`<button class="evidence-btn" data-section="screenshots" title="${t.screenshots.length} screenshot(s)"><i class="fas fa-image evidence-icon"></i></button>`);
    if (t.videos.length)      evidenceHtml.push(`<button class="evidence-btn" data-section="video" title="${t.videos.length} video(s)"><i class="fas fa-video evidence-icon"></i></button>`);
    if (t.traces.length)      evidenceHtml.push(`<button class="evidence-btn" data-section="traces" title="${t.traces.length} trace(s)"><i class="fas fa-route evidence-icon"></i></button>`);
    const evidenceCell = evidenceHtml.length ? evidenceHtml.join('') : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="font-medium text-slate-900">${escapeHtml(t.name)}</div>
        ${t.file ? `<div class="text-xs text-slate-500">${escapeHtml(t.file)}${t.project ? ' · ' + escapeHtml(t.project) : ''}</div>` : ''}
      </td>
      <td><span class="status-badge status-${t.status}">${t.status}</span></td>
      <td class="text-slate-600 text-xs">${formatDuration(t.durationMs)}</td>
      <td class="text-slate-600 text-xs">${t.retries}</td>
      <td>${evidenceCell}</td>
      <td class="error-cell" title="${escapeHtml(t.errorMessage)}">${escapeHtml(t.errorMessage || '')}</td>
    `;
    tr.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-section]');
      openDetail(t, btn?.dataset.section);
    });
    testTableBody.appendChild(tr);
  }

  if (paginationBar) renderPaginationBar(filtered.length, totalPages, start);
}

function renderPaginationBar(totalRows, totalPages, start) {
  const paginationBar = document.getElementById('paginationBar');
  if (!paginationBar) return;
  // Always show the page-size selector; navigation controls only when there is
  // more than one page.
  paginationBar.classList.remove('hidden');
  const end = Math.min(start + pageSize, totalRows);
  document.getElementById('paginationLabel').textContent = `${start + 1}-${end} of ${totalRows}`;
  document.getElementById('pageIndicator').textContent = `${currentPage} / ${totalPages}`;
  document.getElementById('prevPage').disabled = currentPage <= 1;
  document.getElementById('nextPage').disabled = currentPage >= totalPages;
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ---------- Search + filter ---------- */
searchInput.addEventListener('input', e => { search = e.target.value; currentPage = 1; renderTable(); });
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => applyFilter(btn.dataset.filter, { scroll: false }));
});

// Summary cards are clickable filters as well.
document.querySelectorAll('.stat-clickable').forEach(card => {
  card.addEventListener('click', () => {
    applyFilter(card.dataset.filter, { scroll: true });
    // Hide the hover hint immediately after a click and re-enable it once the
    // pointer leaves so the next hover works normally.
    card.classList.add('no-tooltip');
    card.blur();
  });
  card.addEventListener('mouseleave', () => card.classList.remove('no-tooltip'));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      applyFilter(card.dataset.filter, { scroll: true });
      card.classList.add('no-tooltip');
      card.blur();
    }
  });
});

function applyFilter(status, { scroll } = { scroll: false }) {
  filter = status;
  currentPage = 1;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === status);
  });
  renderTable();
  if (scroll) {
    document.getElementById('filterBar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ---------- Pagination wiring ---------- */
document.getElementById('pageSize').addEventListener('change', e => {
  pageSize = Number(e.target.value);
  currentPage = 1;
  renderTable();
  scrollTableIntoView();
});
document.getElementById('prevPage').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; renderTable(); scrollTableIntoView(); }
});
document.getElementById('nextPage').addEventListener('click', () => {
  currentPage++; renderTable(); scrollTableIntoView();
});

function scrollTableIntoView() {
  document.getElementById('filterBar').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Detail modal ---------- */
async function openDetail(t, scrollTo) {
  modalTitle.textContent = t.name;
  const parts = [];

  parts.push(`
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
      <div><p class="text-xs text-slate-500 uppercase">Status</p><span class="status-badge status-${t.status} mt-1">${t.status}</span></div>
      <div><p class="text-xs text-slate-500 uppercase">Duration</p><p class="font-medium">${formatDuration(t.durationMs)}</p></div>
      <div><p class="text-xs text-slate-500 uppercase">Retries</p><p class="font-medium">${t.retries}</p></div>
      <div><p class="text-xs text-slate-500 uppercase">Project</p><p class="font-medium">${escapeHtml(t.project || '')}</p></div>
    </div>
  `);
  if (t.file) {
    parts.push(`<div class="text-xs text-slate-500">Source: <span class="font-mono">${escapeHtml(t.file)}</span></div>`);
  }

  if (t.errorMessage || t.errorStack) {
    parts.push(`
      <div id="section-error">
        <h3 class="font-semibold text-slate-900 mb-2">Error</h3>
        ${t.failureCategory ? `<p class="text-xs text-slate-500 mb-2">Category: <span class="font-medium text-slate-700">${t.failureCategory}</span></p>` : ''}
        <pre>${escapeHtml(t.errorMessage || '')}${t.errorStack ? '\n\n' + escapeHtml(t.errorStack) : ''}</pre>
      </div>
    `);
  }

  // Test Steps — shown for every status (passed, failed, flaky, skipped).
  parts.push(renderStepsSection(t));

  if (t.screenshots.length) {
    parts.push(`
      <div id="section-screenshots">
        <h3 class="font-semibold text-slate-900 mb-2">Screenshots (${t.screenshots.length})</h3>
        <div class="space-y-3">
          ${t.screenshots.map(s => `
            <div>
              <p class="text-xs text-slate-500 mb-1 font-mono">${escapeHtml(s.name)}</p>
              <img class="screenshot" src="${s.blobUrl}" alt="${escapeHtml(s.name)}" />
            </div>
          `).join('')}
        </div>
      </div>
    `);
  }

  if (t.videos.length) {
    parts.push(`
      <div id="section-video">
        <h3 class="font-semibold text-slate-900 mb-2">Video</h3>
        ${t.videos.map(v => `
          <p class="text-xs text-slate-500 mb-1 font-mono">${escapeHtml(v.name)}</p>
          <video controls src="${v.blobUrl}"></video>
        `).join('')}
      </div>
    `);
  }

  if (t.traces.length) {
    parts.push(renderTracesSection(t));
  }

  if (!t.screenshots.length && !t.videos.length && !t.traces.length && !t.errorMessage && !hasAnySteps(t)) {
    parts.push('<p class="text-sm text-slate-500">No additional evidence available for this test.</p>');
  }

  modalContent.innerHTML = parts.join('');
  detailModal.classList.remove('hidden');

  // Always start at the very top of the modal.
  const scrollable = modalContent.parentElement;
  scrollable.scrollTop = 0;

  if (scrollTo) {
    // Wait for layout to settle (modal was just unhidden), then scroll to the
    // target section using explicit scrollTop so we control exactly which
    // container moves and avoid smooth-animation / ancestor-scroll conflicts.
    setTimeout(() => {
      const target = document.getElementById(`section-${scrollTo}`);
      if (!target) return;
      const card = modalContent.parentElement;
      const titleBar = card.children[0]; // sticky modal header (title + close btn)
      const titleH = titleBar ? titleBar.offsetHeight : 0;
      const delta = target.getBoundingClientRect().top - card.getBoundingClientRect().top;
      card.scrollTop = Math.max(0, card.scrollTop + delta - titleH);
    }, 150);
  } else {
    // Lock at top for 600 ms so trace iframes loading in the background
    // cannot drag the scroll position down.
    const resetTop = () => { scrollable.scrollTop = 0; };
    scrollable.addEventListener('scroll', resetTop);
    setTimeout(() => scrollable.removeEventListener('scroll', resetTop), 600);
  }

  if (t.traces.length) {
    await hydrateTraceIframes(t);
  }
}

/* ----- Test Steps ----- */
function hasAnySteps(t) {
  return (t.attempts || []).some(a => (a.steps || []).length > 0);
}

function renderStepsSection(t) {
  const lastAttempt = t.attempts && t.attempts.length ? t.attempts[t.attempts.length - 1] : null;
  const steps = lastAttempt?.steps || [];
  const retryNote = t.retries > 0 ? ` <span class="text-xs text-slate-500 font-normal">(showing final attempt of ${t.retries + 1})</span>` : '';

  if (!steps.length) {
    return `
      <div>
        <h3 class="font-semibold text-slate-900 mb-2">Test Steps${retryNote}</h3>
        <p class="text-sm text-slate-500">No step trace recorded for this test.</p>
      </div>
    `;
  }
  return `
    <div>
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-semibold text-slate-900">Test Steps${retryNote}</h3>
      </div>
      <div class="step-filter-bar mb-3">
        <input type="text" class="step-filter-input" placeholder="🔍  Filter steps" oninput="filterSteps(this)" />
      </div>
      <div class="step-tree">
        ${steps.map(s => renderStepNode(s, 0)).join('')}
      </div>
    </div>
  `;
}

function renderStepNode(step, depth) {
  const hasChildren = (step.steps || []).length > 0;
  const hasError = !!(step.error?.message || step.error);
  const hasSnippet = typeof step.snippet === 'string' && step.snippet.length > 0;
  const expandable = hasChildren || hasSnippet;

  const status = hasError ? 'fail' : (step.skip ? 'skip' : 'pass');
  const icon = status === 'fail' ? '✗' : (status === 'skip' ? '⊘' : '✓');
  const dur = step.duration != null ? formatDuration(step.duration) : '';
  const title = step.title || '';
  const locationText = step.location?.file
    ? ` · <span class="step-loc">${escapeHtml(step.location.file)}${step.location.line != null ? `:${step.location.line}` : ''}</span>`
    : '';

  const errorHtml = hasError
    ? `<div class="step-error">${escapeHtml(typeof step.error === 'string' ? step.error : (step.error.message || ''))}</div>`
    : '';

  const snippetHtml = hasSnippet
    ? `<pre class="step-snippet">${escapeHtml(step.snippet)}</pre>`
    : '';

  const searchText = `${title} ${step.location?.file || ''}`.toLowerCase();

  if (expandable) {
    return `
      <details class="step-node" data-search="${escapeHtml(searchText)}" ${hasError ? 'open' : ''}>
        <summary>
          <span class="step-row">
            <span class="step-status ${status}">${icon}</span>
            <span class="step-title">${escapeHtml(title)}${locationText}</span>
            <span class="step-meta">${dur}</span>
          </span>
        </summary>
        <div class="step-body">
          ${snippetHtml}
          ${errorHtml}
          ${step.steps.map(s => renderStepNode(s, depth + 1)).join('')}
        </div>
      </details>
    `;
  }
  return `
    <div class="step-node step-leaf" data-search="${escapeHtml(searchText)}">
      <span class="step-row">
        <span class="step-status ${status}">${icon}</span>
        <span class="step-title">${escapeHtml(title)}${locationText}</span>
        <span class="step-meta">${dur}</span>
      </span>
      ${errorHtml}
    </div>
  `;
}

function filterSteps(input) {
  const term = input.value.toLowerCase().trim();
  const tree = input.closest('div').nextElementSibling;
  if (!tree) return;
  tree.querySelectorAll('.step-node').forEach(node => {
    if (!term) {
      node.style.display = '';
      return;
    }
    const hay = node.dataset.search || '';
    const descendantMatches = Array.from(node.querySelectorAll('.step-node'))
      .some(child => (child.dataset.search || '').includes(term));
    const selfMatches = hay.includes(term);
    if (selfMatches || descendantMatches) {
      node.style.display = '';
      if (node.tagName === 'DETAILS' && descendantMatches && !selfMatches) node.open = true;
    } else {
      node.style.display = 'none';
    }
  });
}
window.filterSteps = filterSteps;

/* ----- Traces (direct inline rendering via postMessage) ----- */
function renderTracesSection(t) {
  return `
    <div id="section-traces">
      <h3 class="font-semibold text-slate-900 mb-2">Traces (${t.traces.length})</h3>
      <p class="text-xs text-slate-500 mb-3">
        Rendered inline: actions, network, console, and DOM snapshots. Sequential traces shown one after another below.
      </p>
      <div class="space-y-6">
        ${t.traces.map((tr, i) => `
          <div>
            <div class="flex items-center justify-between mb-2">
              <p class="text-sm font-medium text-slate-700">
                ${t.traces.length > 1 ? `Attempt ${i + 1}` : 'Trace'}
                <span class="text-xs text-slate-400 font-mono ml-2">${escapeHtml(tr.name)}</span>
              </p>
              <a href="${tr.blobUrl}" download="${escapeHtml(tr.name)}" class="text-xs text-slate-500 hover:text-brand-dark">⬇ Download</a>
            </div>
            <iframe
              class="trace-frame"
              data-trace-index="${i}"
              src="https://trace.playwright.dev/"
              title="Trace ${i + 1}"
              loading="lazy"></iframe>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function hydrateTraceIframes(t) {
  for (let i = 0; i < t.traces.length; i++) {
    const tr = t.traces[i];
    const iframe = modalContent.querySelector(`iframe.trace-frame[data-trace-index="${i}"]`);
    if (!iframe) continue;

    // Pull the blob bytes back from the blob URL.
    let blob;
    try {
      blob = await fetch(tr.blobUrl).then(r => r.blob());
    } catch (e) {
      console.warn('[trace] failed to read blob:', e);
      continue;
    }

    if (iframe.dataset.loaded === 'true') {
      loadTraceIntoIframe(iframe, blob);
    } else {
      iframe.addEventListener('load', () => {
        iframe.dataset.loaded = 'true';
        loadTraceIntoIframe(iframe, blob);
      }, { once: true });
    }
  }
}

document.getElementById('closeModal').addEventListener('click', closeDetail);
detailModal.addEventListener('click', e => { if (e.target === detailModal) closeDetail(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
function closeDetail() {
  detailModal.classList.add('hidden');
  modalContent.innerHTML = '';
}
