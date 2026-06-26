/**
 * Parses a Playwright test-results ZIP into a normalized array of test records.
 *
 * Strategies, tried in order until one yields tests:
 *  1. Direct JSON reporter output: `report.json` / `results.json` at root or
 *     elsewhere, with a `suites > specs > tests` tree.
 *  2. Inlined HTML reporter: `playwright-report/index.html` containing
 *     <template id="playwrightReportBase64">data:application/zip;base64,...</template>
 *     (Playwright also has used a <script> tag with the same id in some
 *     versions; both shapes are accepted.)
 *     The decoded inner ZIP holds:
 *       - `report.json` — HTML reporter format: { files: [{ fileId, fileName,
 *         tests: [{ testId, title, outcome, results: [{ attachments }] }] }] }
 *       - `<fileId>.json` — per-source-file detail with full results (errors,
 *         steps). Only generated for files containing non-passed tests.
 *     Attachment paths are `data/<hash>.<ext>` resolved against the OUTER ZIP
 *     relative to `index.html`'s folder (typically `playwright-report/data/`).
 *  3. Folder scan: `test-results/<test-folder>/` artifacts. Playwright only
 *     writes these for failed tests by default, so this path returns failed
 *     and flaky entries only — and emits a warning to that effect.
 *
 * Returns { tests, warning? }.
 */

const FAIL_RX = /^(failed|timedout|interrupted)$/i;
const PASS_RX = /^(passed|expected)$/i;
const FLAKY_RX = /^flaky$/i;

async function parseZip(file, onProgress) {
  const zip = await JSZip.loadAsync(file);
  const fileNames = Object.keys(zip.files);
  onProgress?.(`Loaded ${fileNames.length} entries`, 0.15);

  let tests = null;
  let warning = null;
  let meta = { startTime: null, duration: null };

  // Strategy 1: direct JSON reporter output (not inside playwright-report/).
  const directJsonPath = fileNames.find(p =>
    /(^|\/)(report|results)\.json$/i.test(p)
    && !zip.files[p].dir
    && !/playwright-report\//i.test(p)
  );
  if (directJsonPath) {
    onProgress?.(`Parsing ${directJsonPath}`, 0.3);
    try {
      const parsed = JSON.parse(await zip.files[directJsonPath].async('string'));
      meta = extractReportMeta(parsed);
      if (parsed.suites) {
        tests = parseJsonReporterFormat(parsed);
        await attachJsonReporterArtifacts(tests, zip);
      } else if (parsed.files) {
        // Rare but possible: HTML-reporter-shaped report.json at root.
        tests = await parseHtmlReporterFormat(parsed, null, zip, '');
      }
    } catch (e) {
      console.warn('[parser] failed to parse direct JSON report:', e);
    }
  }

  // Strategy 2: inlined HTML report data.
  // Build prioritized candidate list: prefer paths under playwright-report/ but
  // not under playwright-report/trace/ (that's the trace viewer, not the report).
  if (!tests || !tests.length) {
    const candidates = fileNames
      .filter(p => /(^|\/)index\.html$/i.test(p) && !zip.files[p].dir)
      .filter(p => !/\/trace\//i.test(p))
      .sort((a, b) => {
        const aPriority = /playwright-report\//i.test(a) ? 0 : 1;
        const bPriority = /playwright-report\//i.test(b) ? 0 : 1;
        return aPriority - bPriority;
      });
    console.log('[parser] index.html candidates:', candidates);

    for (const htmlPath of candidates) {
      onProgress?.(`Reading ${htmlPath}`, 0.3);
      const html = await zip.files[htmlPath].async('string');
      const base64 = extractInlinedBase64(html);
      const basePath = htmlPath.replace(/index\.html$/i, '');
      console.log('[parser] trying', htmlPath, { size: html.length, base64found: !!base64, base64len: base64?.length });

      if (!base64) continue;

      try {
        onProgress?.('Decoding inlined report ZIP', 0.4);
        const innerZip = await JSZip.loadAsync(base64ToBytes(base64));
        const innerNames = Object.keys(innerZip.files);
        const innerJsonPath = innerNames.find(p =>
          /(^|\/)report\.json$/i.test(p) && !innerZip.files[p].dir
        );
        console.log('[parser] inner ZIP', { entries: innerNames.length, hasReportJson: !!innerJsonPath, sample: innerNames.slice(0, 5) });

        if (!innerJsonPath) continue;

        onProgress?.('Parsing inlined report data', 0.55);
        const parsed = JSON.parse(await innerZip.files[innerJsonPath].async('string'));
        console.log('[parser] inlined report shape', { hasFiles: !!parsed.files, hasSuites: !!parsed.suites, fileCount: parsed.files?.length });
        meta = extractReportMeta(parsed);
        if (parsed.files) {
          tests = await parseHtmlReporterFormat(parsed, innerZip, zip, basePath);
        } else if (parsed.suites) {
          tests = parseJsonReporterFormat(parsed);
          await attachJsonReporterArtifacts(tests, zip);
        }
        console.log('[parser] extracted', tests?.length, 'tests from', htmlPath);
        if (tests?.length) break;
      } catch (e) {
        console.warn('[parser] candidate', htmlPath, 'failed:', e);
      }
    }
  }

  // Strategy 3: folder scan fallback.
  if (!tests || !tests.length) {
    onProgress?.('Scanning test-results folders', 0.5);
    tests = parseArtifactFolders(zip);
    await attachFolderScanArtifacts(tests, zip);
    if (tests.length) {
      const allFailedOrFlaky = tests.every(t => t.status === 'failed' || t.status === 'flaky');
      if (allFailedOrFlaky) {
        warning = 'No JSON or HTML report was found in this ZIP, so only failed test folders are visible. Playwright does not write artifact folders for passed tests by default. Include playwright-report/index.html or run with --reporter=json to see passed tests.';
      }
    }
  }

  if (!tests || !tests.length) {
    throw new Error('No tests found. Expected report.json, playwright-report/index.html, or a test-results/ folder.');
  }

  tests.forEach(t => { t.failureCategory = classifyFailure(t.errorMessage); });

  // Fallback duration: sum of per-test durations if the report didn't supply one.
  if (!meta.duration) {
    const sum = tests.reduce((a, t) => a + (t.durationMs || 0), 0);
    if (sum > 0) meta.duration = sum;
  }

  onProgress?.('Done', 1);
  return { tests, warning, meta };
}

function extractReportMeta(report) {
  if (!report) return { startTime: null, duration: null };
  // HTML reporter has them at top level; JSON reporter places them under .stats.
  const startTime = report.startTime || report.stats?.startTime || null;
  const duration = report.duration || report.stats?.duration || null;
  return { startTime, duration };
}

/* ---------- JSON reporter format (suites > specs > tests) ---------- */

function parseJsonReporterFormat(report) {
  const out = [];
  const walk = (suites, parentTitles = []) => {
    for (const suite of suites || []) {
      const titles = [...parentTitles, suite.title].filter(Boolean);
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          const results = test.results || [];
          const last = results[results.length - 1] || {};
          const status = deriveJsonReporterStatus(test, results);
          const name = [...titles, spec.title].filter(Boolean).join(' › ');
          out.push({
            id: spec.id || `${name}-${test.projectName || ''}`,
            name,
            file: spec.file || suite.file || '',
            project: test.projectName || '',
            status,
            durationMs: results.reduce((a, r) => a + (r.duration || 0), 0),
            retries: Math.max(0, results.length - 1),
            errorMessage: extractError(last)?.message || '',
            errorStack: extractError(last)?.stack || '',
            attempts: results.map(r => ({
              status: r.status,
              duration: r.duration,
              error: extractError(r),
              attachments: r.attachments || [],
              steps: r.steps || [],
            })),
            screenshots: [],
            videos: [],
            traces: [],
            otherFiles: [],
          });
        }
      }
      walk(suite.suites, titles);
    }
  };
  walk(report.suites);
  return out;
}

function deriveJsonReporterStatus(test, results) {
  if (FLAKY_RX.test(test.status || '')) return 'flaky';
  if (results.length > 1) {
    const passes = results.filter(r => PASS_RX.test(r.status));
    const fails = results.filter(r => FAIL_RX.test(r.status));
    if (passes.length && fails.length) return 'flaky';
  }
  const last = results[results.length - 1];
  if (!last) return 'unknown';
  if (PASS_RX.test(last.status)) return 'passed';
  if (FAIL_RX.test(last.status)) return 'failed';
  if (/skipped/i.test(last.status)) return 'skipped';
  if (test.status === 'expected') return 'passed';
  if (test.status === 'unexpected') return 'failed';
  if (test.status === 'skipped') return 'skipped';
  return last.status || 'unknown';
}

function extractError(result) {
  if (!result) return null;
  if (result.error) return { message: result.error.message || '', stack: result.error.stack || '' };
  if (result.errors?.length) {
    const e = result.errors[0];
    return { message: e.message || '', stack: e.stack || '' };
  }
  return null;
}

async function attachJsonReporterArtifacts(tests, zip) {
  for (const test of tests) {
    for (const attempt of test.attempts || []) {
      for (const att of (attempt.attachments || [])) {
        if (!att.path) continue;
        const entry = resolveEntry(zip, att.path);
        if (entry) await assignArtifact(test, att.name || att.path, entry, att.contentType);
      }
    }
  }
}

/* ---------- HTML reporter format (files > tests with outcome) ---------- */

async function parseHtmlReporterFormat(data, innerZip, outerZip, basePath) {
  const out = [];

  // Load detail files lazily, keyed by fileId.
  const detailByFileId = new Map();
  const loadDetail = async (fileId) => {
    if (!innerZip || !fileId) return null;
    if (detailByFileId.has(fileId)) return detailByFileId.get(fileId);
    const path = Object.keys(innerZip.files).find(p =>
      p === `${fileId}.json` || p.endsWith(`/${fileId}.json`)
    );
    if (!path) { detailByFileId.set(fileId, null); return null; }
    try {
      const detail = JSON.parse(await innerZip.files[path].async('string'));
      detailByFileId.set(fileId, detail);
      return detail;
    } catch (e) {
      console.warn(`[parser] failed to read detail ${path}:`, e);
      detailByFileId.set(fileId, null);
      return null;
    }
  };

  for (const file of data.files || []) {
    const detail = await loadDetail(file.fileId);
    for (const t of file.tests || []) {
      const status = mapOutcomeToStatus(t.outcome);
      const titleParts = [];
      if (Array.isArray(t.path)) titleParts.push(...t.path);
      if (t.title) titleParts.push(t.title);

      const record = {
        id: t.testId || `${file.fileId || file.fileName}-${t.title}`,
        name: titleParts.length ? titleParts.join(' › ') : (t.title || 'Untitled test'),
        file: file.fileName || (t.location?.file) || '',
        project: t.projectName || '',
        status,
        durationMs: t.duration || 0,
        retries: Math.max(0, (t.results || []).length - 1),
        errorMessage: '',
        errorStack: '',
        attempts: (t.results || []).map(r => ({
          status: r.status || (status === 'passed' ? 'passed' : ''),
          duration: r.duration || 0,
          attachments: r.attachments || [],
        })),
        screenshots: [],
        videos: [],
        traces: [],
        otherFiles: [],
      };

      // Merge richer info (errors, attachments, steps) from the per-file detail.
      const detailTest = detail?.tests?.find(d => d.testId === t.testId);
      if (detailTest) {
        const results = detailTest.results || [];
        record.retries = Math.max(record.retries, Math.max(0, results.length - 1));
        const last = results[results.length - 1] || {};
        const errs = last.errors || (last.error ? [last.error] : []);
        if (errs[0]) {
          record.errorMessage = errs[0].message || '';
          record.errorStack = errs[0].stack || '';
        }
        // Prefer detail's attachments (they always include the full retry chain).
        record.attempts = results.map(r => ({
          status: r.status,
          duration: r.duration,
          attachments: r.attachments || [],
          steps: r.steps || [],
        }));
      }

      // Resolve attachments against the OUTER ZIP under index.html's folder.
      const seen = new Set();
      for (const attempt of record.attempts) {
        for (const att of (attempt.attachments || [])) {
          if (!att.path || seen.has(att.path)) continue;
          seen.add(att.path);
          const candidates = [
            basePath + att.path,
            att.path,
            'playwright-report/' + att.path,
          ];
          let entry = null;
          for (const p of candidates) {
            entry = resolveEntry(outerZip, p);
            if (entry) break;
          }
          if (!entry && innerZip) entry = resolveEntry(innerZip, att.path);
          if (entry) await assignArtifact(record, att.name || att.path, entry, att.contentType);
        }
      }

      // If we still have no error text but the test is failed, try error-context.md.
      if (!record.errorMessage && (status === 'failed' || status === 'flaky')) {
        for (const attempt of record.attempts) {
          const ctx = (attempt.attachments || []).find(a => /error-context/i.test(a.name || '') || /\.md$/i.test(a.path || ''));
          if (ctx?.path) {
            const entry = resolveEntry(outerZip, basePath + ctx.path) || resolveEntry(outerZip, ctx.path);
            if (entry) {
              try {
                const txt = await entry.async('string');
                record.errorMessage = txt.split('\n').filter(l => l.trim()).slice(0, 4).join('\n');
                break;
              } catch {}
            }
          }
        }
      }

      out.push(record);
    }
  }
  return out;
}

function mapOutcomeToStatus(outcome) {
  switch ((outcome || '').toLowerCase()) {
    case 'expected': return 'passed';
    case 'unexpected': return 'failed';
    case 'flaky': return 'flaky';
    case 'skipped': return 'skipped';
    default: return outcome || 'unknown';
  }
}

/* ---------- Folder-scanning fallback ---------- */

function parseArtifactFolders(zip) {
  const folderMap = new Map();
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (entry.dir) continue;
    const segments = path.split('/').filter(Boolean);
    const idx = segments.indexOf('test-results');
    if (idx === -1 || idx >= segments.length - 2) continue;
    const folder = segments[idx + 1];
    const fileName = segments.slice(idx + 2).join('/');
    const { base, retry } = splitRetry(folder);
    if (!folderMap.has(base)) folderMap.set(base, { attempts: [] });
    const attempts = folderMap.get(base).attempts;
    let attempt = attempts.find(a => a.retry === retry);
    if (!attempt) { attempt = { retry, files: [] }; attempts.push(attempt); }
    attempt.files.push({ path, fileName, entry });
  }

  const out = [];
  for (const [base, info] of folderMap.entries()) {
    info.attempts.sort((a, b) => a.retry - b.retry);
    const last = info.attempts[info.attempts.length - 1];
    const anyFailed = info.attempts.some(a => a.files.some(f => /test-failed.*\.png$/i.test(f.fileName)));
    const lastFailed = last.files.some(f => /test-failed.*\.png$/i.test(f.fileName));
    let status;
    if (info.attempts.length > 1 && !lastFailed && anyFailed) status = 'flaky';
    else if (lastFailed) status = 'failed';
    else status = 'passed';
    out.push({
      id: base,
      name: humanize(base),
      file: '',
      project: detectProject(base),
      status,
      durationMs: 0,
      retries: Math.max(0, info.attempts.length - 1),
      errorMessage: '',
      errorStack: '',
      attempts: info.attempts.map(() => ({ status: 'unknown', duration: 0, attachments: [] })),
      _attemptFiles: info.attempts,
      screenshots: [],
      videos: [],
      traces: [],
      otherFiles: [],
    });
  }
  return out;
}

async function attachFolderScanArtifacts(tests, zip) {
  for (const test of tests) {
    if (!test._attemptFiles) continue;
    for (const attempt of test._attemptFiles) {
      for (const f of attempt.files) {
        await assignArtifact(test, f.fileName, zip.files[f.path]);
      }
      const errCtx = attempt.files.find(f => /error-context\.md$/i.test(f.fileName));
      if (errCtx && !test.errorMessage) {
        const txt = await zip.files[errCtx.path].async('string');
        test.errorMessage = txt.split('\n').filter(l => l.trim()).slice(0, 4).join('\n').trim();
      }
    }
    delete test._attemptFiles;
  }
}

function splitRetry(folder) {
  const m = folder.match(/^(.*)-retry(\d+)$/);
  if (m) return { base: m[1], retry: parseInt(m[2], 10) };
  return { base: folder, retry: 0 };
}

function humanize(s) {
  return s.replace(/-(chromium|firefox|webkit|chrome|edge|safari)$/i, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());
}

function detectProject(folder) {
  const m = folder.match(/-(chromium|firefox|webkit|chrome|edge|safari)$/i);
  return m ? m[1].toLowerCase() : '';
}

/* ---------- Artifact helpers ---------- */

function resolveEntry(zip, path) {
  if (!zip || !path) return null;
  if (zip.files[path] && !zip.files[path].dir) return zip.files[path];
  const norm = path.replace(/^\.?\//, '');
  if (zip.files[norm] && !zip.files[norm].dir) return zip.files[norm];
  const tail = '/' + path.replace(/^.*[\\/]/, '');
  return Object.values(zip.files).find(f => !f.dir && (f.name === path || f.name === norm || f.name.endsWith(tail)));
}

async function assignArtifact(test, name, entry, contentTypeHint) {
  if (!entry || entry.dir) return;
  const lower = (name || '').toLowerCase();
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(lower) || /^image\//.test(contentTypeHint || '');
  const isVideo = /\.(webm|mp4|mov)$/i.test(lower) || /^video\//.test(contentTypeHint || '');
  const isTrace = /trace.*\.zip$/i.test(lower) || lower.endsWith('trace.zip') || (contentTypeHint === 'application/zip' && /trace/i.test(name || ''));
  if (isImage) {
    const blob = await entry.async('blob');
    const mime = contentTypeHint || 'image/png';
    test.screenshots.push({ name, blobUrl: URL.createObjectURL(new Blob([blob], { type: mime })) });
  } else if (isVideo) {
    const blob = await entry.async('blob');
    const mime = contentTypeHint || 'video/webm';
    test.videos.push({ name, blobUrl: URL.createObjectURL(new Blob([blob], { type: mime })), mime });
  } else if (isTrace) {
    const blob = await entry.async('blob');
    test.traces.push({ name, blobUrl: URL.createObjectURL(blob) });
  } else if (/error-context/i.test(name || '') || /\.md$/i.test(lower)) {
    // error-context.md is consumed for the error message; no asset entry.
  } else {
    test.otherFiles.push({ name });
  }
}

/* ---------- Failure categorization ---------- */

function classifyFailure(msg) {
  if (!msg) return null;
  const s = msg.toLowerCase();
  if (/timeout|timed out|exceeded.*ms|waiting for/.test(s)) return 'Timeout';
  if (/expect|assertion|tobe|tohave|to equal|to match|received/.test(s)) return 'Assertion';
  if (/network|fetch|net::|connection|econnrefused|enotfound|503|502|504/.test(s)) return 'Network';
  if (/locator|element.*not found|target closed|page.*closed/.test(s)) return 'Locator';
  return 'Other';
}

/* ---------- Helpers ---------- */

/**
 * Pulls the base64-encoded inner ZIP payload out of a Playwright HTML report.
 * Handles every embedding shape the reporter has used:
 *   1. <template id="playwrightReportBase64">data:application/zip;base64,...</template>
 *      (current default, 1.30+ - uses <template> to avoid the browser executing it as a script)
 *   2. <script id="playwrightReportBase64" type="application/zip">data:...</script>
 *      (some intermediate versions)
 *   3. playwrightReportBase64 = "data:application/zip;base64,..."  (legacy assignment)
 *   4. Any data: URI for application/zip embedded anywhere in the document.
 */
function extractInlinedBase64(html) {
  // Patterns 1 & 2: any element with id="playwrightReportBase64".
  let m = html.match(/<(template|script)[^>]*id=["']playwrightReportBase64["'][^>]*>([\s\S]*?)<\/\1>/i);
  if (m) {
    const body = m[2].trim();
    const stripped = body.replace(/^data:application\/zip;base64,/, '');
    if (stripped.length > 100) return stripped;
  }
  // Pattern 3: JS assignment.
  m = html.match(/playwrightReportBase64\s*=\s*["']data:application\/zip;base64,([A-Za-z0-9+/=\s]+?)["']/);
  if (m) return m[1];
  // Pattern 4: any embedded data URI for application/zip.
  m = html.match(/data:application\/zip;base64,([A-Za-z0-9+/=\s]{200,})/);
  if (m) return m[1].replace(/[^A-Za-z0-9+/=\s].*$/s, '');
  return null;
}

function base64ToBytes(base64) {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---------- Standalone HTML report ---------- */

async function parseHtmlFile(file, onProgress) {
  onProgress?.('Reading HTML report', 0.1);
  const html = await file.text();

  const base64 = extractInlinedBase64(html);
  if (!base64) {
    throw new Error('No Playwright report data found. Upload the index.html generated by the Playwright HTML reporter.');
  }

  onProgress?.('Decoding embedded report data', 0.35);
  const innerZip = await JSZip.loadAsync(base64ToBytes(base64));
  const innerNames = Object.keys(innerZip.files);

  const innerJsonPath = innerNames.find(p =>
    /(^|\/)report\.json$/i.test(p) && !innerZip.files[p].dir
  );
  if (!innerJsonPath) {
    throw new Error('Could not find report.json in the embedded data. This may not be a Playwright HTML report.');
  }

  onProgress?.('Parsing report', 0.55);
  const parsed = JSON.parse(await innerZip.files[innerJsonPath].async('string'));
  const meta = extractReportMeta(parsed);

  let tests = null;
  if (parsed.files) {
    // Pass innerZip as outerZip too — newer Playwright versions embed
    // attachment files inside the inner ZIP alongside the JSON data.
    tests = await parseHtmlReporterFormat(parsed, innerZip, innerZip, '');
  } else if (parsed.suites) {
    tests = parseJsonReporterFormat(parsed);
  }

  if (!tests?.length) {
    throw new Error('No tests found in this HTML report.');
  }

  tests.forEach(t => { t.failureCategory = classifyFailure(t.errorMessage); });

  if (!meta.duration) {
    const sum = tests.reduce((a, t) => a + (t.durationMs || 0), 0);
    if (sum > 0) meta.duration = sum;
  }

  onProgress?.('Done', 1);
  return { tests, warning: null, meta };
}

window.parseZip = parseZip;
window.parseHtmlFile = parseHtmlFile;
