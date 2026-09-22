/* DAGitty — Test the implications against data
 *
 * The Testable-implications panel lists the conditional independencies a
 * diagram predicts, and the methods statement tells the user to go and run
 * localTests() in R. This closes that loop in the browser: upload the study
 * data, match its columns to the diagram's variables, and every implied
 * independence X ⊥ Y | Z is tested with a partial-correlation test using
 * Fisher's z transformation — the "cis" test of dagitty::localTests(), which
 * is also the test used by the discovery tool in causal-discovery.js.
 *
 * For each test the tool reports the partial correlation, its 95 % confidence
 * interval, the p-value and a Holm-adjusted p-value, and it produces a
 * ready-to-paste sentence for the methods statement.
 *
 * Limits are stated in the dialog: the test is linear and treats every
 * variable as numeric; binary / ordinal codes are used as they are.
 */

(function () {
    'use strict';

    var Z975 = 1.959963984540054;   // Φ⁻¹(0.975)
    var IMPLICATION_CAP = 1000;

    function ids(vs) { return _.pluck(vs || [], 'id'); }
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Statistics ────────────────────────────────────────────────────────

    function atanhClamped(r) {
        r = Math.max(-0.999999, Math.min(0.999999, r));
        return 0.5 * Math.log((1 + r) / (1 - r));
    }

    /**
     * Fisher z test of H0: (partial) correlation = 0.
     * @param {number} r  observed (partial) correlation
     * @param {number} n  complete cases used
     * @param {number} k  size of the conditioning set
     * @returns {null|{estimate,z,se,lo,hi,p,n}}  null if n is too small
     */
    function fisherTest(r, n, k) {
        var df = n - k - 3;
        if (!(df > 0)) return null;
        var z = atanhClamped(r), se = 1 / Math.sqrt(df);
        var stat = z / se;
        var p = 2 * (1 - CausalDiscovery.normalCDF(Math.abs(stat)));
        return {
            estimate: r, z: stat, se: se,
            lo: Math.tanh(z - Z975 * se), hi: Math.tanh(z + Z975 * se),
            p: Math.max(0, Math.min(1, p)), n: n
        };
    }

    /** Holm step-down adjusted p-values (same order as the input). */
    function holm(ps) {
        var m = ps.length, adj = new Array(m);
        var order = ps.map(function (p, i) { return i; }).sort(function (a, b) { return ps[a] - ps[b]; });
        var running = 0;
        order.forEach(function (i, rank) {
            running = Math.max(running, Math.min(1, (m - rank) * ps[i]));
            adj[i] = running;
        });
        return adj;
    }

    /**
     * Partial correlation of columns[0] and columns[1] given the rest, from the
     * rows complete for all of them.
     * @returns {{r:number,n:number}|{error:string}}
     */
    function partialFromColumns(columns) {
        var m = columns.length, n = columns[0].length, rows = [];
        for (var i = 0; i < n; i++) {
            var ok = true;
            for (var c = 0; c < m; c++) if (!isFinite(columns[c][i])) { ok = false; break; }
            if (ok) rows.push(i);
        }
        if (rows.length < m + 4) return { error: 'too few complete rows (' + rows.length + ')' };

        var sub = columns.map(function (col) { return rows.map(function (i) { return col[i]; }); });
        var C = [];
        for (var a = 0; a < m; a++) {
            C.push([]);
            for (var b = 0; b < m; b++) C[a].push(a === b ? 1 : CausalDiscovery.pearsonR(sub[a], sub[b]));
        }
        if (m === 2) return { r: C[0][1], n: rows.length };
        var inv = CausalDiscovery.invertMatrix(C);
        if (!inv) return { error: 'variables are collinear' };
        var denom = Math.sqrt(Math.abs(inv[0][0] * inv[1][1]));
        if (denom < 1e-12) return { error: 'variables are collinear' };
        return { r: -inv[0][1] / denom, n: rows.length };
    }

    // ── Implications of the diagram ───────────────────────────────────────

    /**
     * Flatten GraphAnalyzer.listMinimalImplications() into {x, y, z[]} records.
     * Implications involving a selection variable are dropped: everyone in the
     * data is selected, so it is constant and cannot be tested.
     */
    function implicationsOf(g) {
        var raw = GraphAnalyzer.listMinimalImplications(g, IMPLICATION_CAP);
        var selected = ids(g.getSelectedNodes());
        var out = [], droppedSelection = 0, total = 0;
        raw.forEach(function (t) {
            t[2].forEach(function (s) {
                total++;
                var z = ids(s).sort();
                var involvesSel = [t[0], t[1]].concat(z).some(function (v) { return selected.indexOf(v) !== -1; });
                if (involvesSel) { droppedSelection++; return; }
                out.push({ x: t[0], y: t[1], z: z });
            });
        });
        return { list: out, capped: total >= IMPLICATION_CAP, droppedSelection: droppedSelection };
    }

    function implText(imp) {
        return imp.x + ' ⊥ ' + imp.y + (imp.z.length ? ' | ' + imp.z.join(', ') : '');
    }

    // ── Matching diagram variables to data columns ─────────────────────────

    function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

    /** Best-effort column for each variable: exact, then case-insensitive, then punctuation-insensitive. */
    function autoMap(vars, headers) {
        var map = {};
        var lower = {}, normed = {};
        headers.forEach(function (h) {
            if (!(h.toLowerCase() in lower)) lower[h.toLowerCase()] = h;
            if (!(norm(h) in normed)) normed[norm(h)] = h;
        });
        vars.forEach(function (v) {
            if (headers.indexOf(v) !== -1) map[v] = v;
            else if (v.toLowerCase() in lower) map[v] = lower[v.toLowerCase()];
            else if (norm(v) in normed && norm(v) !== '') map[v] = normed[norm(v)];
            else map[v] = null;
        });
        return map;
    }

    // ── Running the tests ─────────────────────────────────────────────────

    /**
     * @param {Graph}  g
     * @param {{columns: Object<string,number[]>}} table  from CausalDiscovery.parseTable
     * @param {Object<string,string|null>} mapping        variable → column
     * @param {number} alpha
     */
    function run(g, table, mapping, alpha) {
        alpha = alpha || 0.05;
        var imps = implicationsOf(g);
        var tests = [];
        imps.list.forEach(function (imp) {
            var names = [imp.x, imp.y].concat(imp.z);
            var missing = names.filter(function (v) { return !mapping[v] || !table.columns[mapping[v]]; });
            if (missing.length) { tests.push({ imp: imp, skipped: 'not in the data: ' + missing.join(', ') }); return; }
            var pc = partialFromColumns(names.map(function (v) { return table.columns[mapping[v]]; }));
            if (pc.error) { tests.push({ imp: imp, skipped: pc.error }); return; }
            var ft = fisherTest(pc.r, pc.n, imp.z.length);
            if (!ft) { tests.push({ imp: imp, skipped: 'too few complete rows (' + pc.n + ')' }); return; }
            tests.push({ imp: imp, estimate: ft.estimate, lo: ft.lo, hi: ft.hi, p: ft.p, z: ft.z, n: ft.n });
        });

        var tested = tests.filter(function (t) { return !t.skipped; });
        var adj = holm(tested.map(function (t) { return t.p; }));
        tested.forEach(function (t, i) {
            t.pHolm = adj[i];
            t.violated = t.p < alpha;
            t.violatedHolm = t.pHolm < alpha;
        });
        tests.sort(function (a, b) {
            if (!!a.skipped !== !!b.skipped) return a.skipped ? 1 : -1;
            if (a.skipped) return 0;
            return a.p - b.p;
        });

        var ns = tested.map(function (t) { return t.n; });
        return {
            tests: tests,
            summary: {
                nImplied: imps.list.length, capped: imps.capped, droppedSelection: imps.droppedSelection,
                tested: tested.length, skipped: tests.length - tested.length,
                violated: tested.filter(function (t) { return t.violated; }).length,
                violatedHolm: tested.filter(function (t) { return t.violatedHolm; }).length,
                alpha: alpha,
                nMin: ns.length ? Math.min.apply(null, ns) : 0,
                nMax: ns.length ? Math.max.apply(null, ns) : 0
            }
        };
    }

    function formatP(p) {
        if (p < 0.001) return 'p < .001';
        return 'p = ' + p.toFixed(3).replace(/^0\./, '.');
    }
    function f2(x) { return (x >= 0 ? '' : '−') + Math.abs(x).toFixed(2); }

    /** One paragraph for the methods statement. */
    function methodsSentence(res) {
        var s = res.summary;
        var nText = s.nMin === s.nMax ? 'n = ' + s.nMin : 'n = ' + s.nMin + '–' + s.nMax + ' complete cases per test';
        var out = 'We tested ' + (s.tested === s.nImplied ? 'all ' : '') + s.tested + ' of the ' +
            (s.capped ? 'at least ' : '') + s.nImplied + ' implied conditional independencies against our data (' +
            nText + ') using partial-correlation tests with Fisher\'s z transformation (α = ' + s.alpha +
            '; equivalent to localTests(type = "cis") in the dagitty R package). ';
        if (s.tested === 0) return out + 'No implication could be tested with the available columns.';
        if (s.violated === 0) {
            out += 'None was rejected, so the data are consistent with the independencies the diagram implies.';
        } else {
            var v = res.tests.filter(function (t) { return t.violated; });
            var shown = v.slice(0, 5).map(function (t) {
                return implText(t.imp) + ' (r = ' + f2(t.estimate) + ', 95% CI ' + f2(t.lo) + ' to ' + f2(t.hi) + ', ' + formatP(t.p) + ')';
            });
            out += s.violated + ' ' + (s.violated === 1 ? 'was' : 'were') + ' rejected: ' + shown.join('; ') +
                (v.length > 5 ? '; and ' + (v.length - 5) + ' more' : '') + '. After Holm correction for multiple testing ' +
                (s.violatedHolm ? s.violatedHolm + ' remained significant.' : 'none remained significant.') +
                ' A rejected independence suggests the diagram omits a relationship between the variables involved, ' +
                'or that a linear test is inappropriate for them.';
        }
        if (s.skipped) {
            out += ' ' + s.skipped + ' implication' + (s.skipped !== 1 ? 's' : '') +
                ' could not be tested (variables absent from the data or too few complete cases).';
        }
        return out;
    }

    /** Tab-separated table of the results, for pasting into a spreadsheet. */
    function toTSV(res) {
        var rows = [['implication', 'estimate', 'ci_low', 'ci_high', 'p', 'p_holm', 'n', 'verdict']];
        res.tests.forEach(function (t) {
            rows.push(t.skipped
                ? [implText(t.imp), '', '', '', '', '', '', 'not tested: ' + t.skipped]
                : [implText(t.imp), t.estimate.toFixed(4), t.lo.toFixed(4), t.hi.toFixed(4), t.p.toExponential(3),
                   t.pHolm.toExponential(3), t.n, t.violated ? 'violated' : 'consistent']);
        });
        return rows.map(function (r) { return r.join('\t'); }).join('\n');
    }

    // ── Dialog ────────────────────────────────────────────────────────────

    var root = null, state = null;

    function ensureRoot() {
        if (root) return;
        root = document.createElement('div');
        root.id = 'lt-modal';
        root.className = 'modal-overlay';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'lt-title');
        root.style.display = 'none';
        root.innerHTML =
            '<div class="modal-dialog modal-dialog-wide">' +
              '<div class="modal-header">' +
                '<h2 id="lt-title">Test the implications against your data</h2>' +
                '<button type="button" class="modal-close" aria-label="Close" id="lt-close">✕</button>' +
              '</div>' +
              '<div class="modal-body">' +
                '<p class="modal-intro">Your diagram predicts that certain pairs of variables are independent once ' +
                  'others are held fixed. Upload the data you collected and each prediction is tested with a ' +
                  'partial-correlation test (Fisher\'s z) — the same test as <code>localTests()</code> in the dagitty R package. ' +
                  'A rejected prediction means the diagram is missing a relationship between those variables.</p>' +
                '<div class="modal-callout">These tests are linear and treat every column as numeric ' +
                  '(binary or ordinal codes are used as they are). Treat the results as a check on the diagram, ' +
                  'not as proof of it: passing does not make the arrows correct.</div>' +
                '<div class="modal-field">' +
                  '<label for="lt-file" class="modal-label">Data file ' +
                    '<span class="modal-label-hint">— CSV, TSV, Excel or plain text; first row = column names</span></label>' +
                  '<input type="file" id="lt-file" accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsb,.ods,text/csv,text/tab-separated-values">' +
                '</div>' +
                '<div id="lt-map-field" class="modal-field" style="display:none">' +
                  '<span class="modal-label">Match diagram variables to data columns ' +
                    '<span class="modal-label-hint">— matched automatically where the names agree; fix any that are wrong</span></span>' +
                  '<table class="lt-map" id="lt-map"><thead><tr><th scope="col">Variable in diagram</th>' +
                    '<th scope="col">Column in data</th></tr></thead><tbody></tbody></table>' +
                '</div>' +
                '<div class="modal-field">' +
                  '<label for="lt-alpha" class="modal-label">Significance level</label>' +
                  '<select id="lt-alpha">' +
                    '<option value="0.01">0.01</option><option value="0.05" selected>0.05</option><option value="0.10">0.10</option>' +
                  '</select>' +
                '</div>' +
                '<div id="lt-status" class="modal-status" aria-live="polite" aria-atomic="true"></div>' +
                '<div id="lt-results" style="display:none">' +
                  '<p id="lt-summary" class="lt-summary"></p>' +
                  '<div class="lt-table-wrap"><table class="lt-table" id="lt-table"><thead><tr>' +
                    '<th scope="col">Implied independence</th><th scope="col">r</th><th scope="col">95% CI</th>' +
                    '<th scope="col">p</th><th scope="col">p (Holm)</th><th scope="col">n</th><th scope="col">Verdict</th>' +
                  '</tr></thead><tbody></tbody></table></div>' +
                '</div>' +
              '</div>' +
              '<div class="modal-footer">' +
                '<button type="button" class="btn-secondary" id="lt-cancel">Close</button>' +
                '<button type="button" class="btn-secondary" id="lt-copy" disabled>Copy table</button>' +
                '<button type="button" class="btn-secondary" id="lt-use" disabled>Use in methods statement</button>' +
                '<button type="button" id="lt-run" disabled>Run tests</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(root);

        root.querySelector('#lt-close').addEventListener('click', close);
        root.querySelector('#lt-cancel').addEventListener('click', close);
        root.addEventListener('click', function (e) { if (e.target === root) close(); });
        document.addEventListener('keydown', function (e) {
            if (root.style.display === 'flex' && e.key === 'Escape') { e.preventDefault(); close(); }
        });
        root.querySelector('#lt-file').addEventListener('change', function () {
            if (this.files && this.files[0]) loadFile(this.files[0]);
        });
        root.querySelector('#lt-run').addEventListener('click', runFromDialog);
        root.querySelector('#lt-use').addEventListener('click', useInMethods);
        root.querySelector('#lt-copy').addEventListener('click', copyTable);
    }

    function setStatus(msg, type) {
        var el = root.querySelector('#lt-status');
        el.textContent = msg || '';
        el.className = 'modal-status' + (type ? ' status-' + type : '');
    }

    function loadFile(file) {
        state.table = null;
        root.querySelector('#lt-run').disabled = true;
        root.querySelector('#lt-results').style.display = 'none';
        TabularFile.read(file, function (err, res) {
            if (err) { setStatus(err.message, 'error'); return; }
            try {
                state.table = CausalDiscovery.parseTable(res.text);
            } catch (e) { setStatus('Could not read ' + res.label + ': ' + e.message, 'error'); return; }
            state.label = res.label;
            renderMapping();
            var msg = 'Loaded ' + res.label + ' — ' + state.table.nRows + ' rows, ' + state.table.headers.length +
                ' numeric column' + (state.table.headers.length !== 1 ? 's' : '') + '.';
            if (state.table.dropped.length) msg += ' Skipped non-numeric: ' + state.table.dropped.slice(0, 6).join(', ') +
                (state.table.dropped.length > 6 ? '…' : '') + '.';
            setStatus(msg + ' Check the matching, then run.', 'success');
            root.querySelector('#lt-run').disabled = false;
        }, function (s) { setStatus(s, 'running'); });
    }

    function diagramVariables(g) {
        var latent = ids(g.getLatentNodes()), selected = ids(g.getSelectedNodes());
        return ids(g.getVertices()).filter(function (v) { return latent.indexOf(v) === -1 && selected.indexOf(v) === -1; }).sort();
    }

    function renderMapping() {
        var g = Model.dag, vars = diagramVariables(g);
        var field = root.querySelector('#lt-map-field');
        var tbody = root.querySelector('#lt-map tbody');
        tbody.innerHTML = '';
        if (!state.table) { field.style.display = 'none'; return; }
        var auto = autoMap(vars, state.table.headers);
        state.mapping = state.mapping || {};
        vars.forEach(function (v) {
            if (!(v in state.mapping) || (state.mapping[v] && state.table.headers.indexOf(state.mapping[v]) === -1)) {
                state.mapping[v] = auto[v];
            }
            var tr = document.createElement('tr');
            var th = document.createElement('th');
            th.scope = 'row'; th.textContent = v;
            tr.appendChild(th);
            var td = document.createElement('td');
            var sel = document.createElement('select');
            sel.setAttribute('aria-label', 'Data column for ' + v);
            var none = document.createElement('option');
            none.value = ''; none.textContent = '— not in the data —';
            sel.appendChild(none);
            state.table.headers.forEach(function (h) {
                var o = document.createElement('option');
                o.value = h; o.textContent = h;
                if (state.mapping[v] === h) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', function () { state.mapping[v] = sel.value || null; });
            td.appendChild(sel);
            tr.appendChild(td);
            tbody.appendChild(tr);
        });
        field.style.display = vars.length ? '' : 'none';
    }

    function runFromDialog() {
        if (!state.table) return;
        var g = Model.dag;
        var alpha = parseFloat(root.querySelector('#lt-alpha').value) || 0.05;
        setStatus('Testing…', 'running');
        var res;
        try { res = run(g, state.table, state.mapping || {}, alpha); }
        catch (e) { setStatus('Could not run the tests: ' + e.message, 'error'); return; }
        res.modelCode = g.toString();
        res.dataLabel = state.label;
        window.LocalTests.last = res;
        renderResults(res);
        var s = res.summary;
        setStatus(s.tested ? 'Tested ' + s.tested + ' implication' + (s.tested !== 1 ? 's' : '') + '.' :
            'Nothing could be tested — match at least two diagram variables to data columns.', s.tested ? 'success' : 'error');
        root.querySelector('#lt-use').disabled = !s.tested;
        root.querySelector('#lt-copy').disabled = !res.tests.length;
    }

    function renderResults(res) {
        var s = res.summary;
        var wrap = root.querySelector('#lt-results');
        var sum = root.querySelector('#lt-summary');
        var tbody = root.querySelector('#lt-table tbody');
        tbody.innerHTML = '';

        var txt;
        if (!s.tested) txt = 'No implication could be tested.';
        else if (!s.violated) txt = 'All ' + s.tested + ' testable implications are consistent with the data at α = ' + s.alpha + '.';
        else txt = s.violated + ' of ' + s.tested + ' implications ' + (s.violated === 1 ? 'is' : 'are') + ' violated at α = ' +
            s.alpha + (s.violatedHolm ? ' (' + s.violatedHolm + ' after Holm correction)' : ' (none after Holm correction)') + '.';
        if (s.skipped) txt += ' ' + s.skipped + ' not tested.';
        if (s.droppedSelection) txt += ' ' + s.droppedSelection + ' involving the selection variable were left out.';
        sum.textContent = txt;
        sum.className = 'lt-summary ' + (s.violated ? 'lt-bad' : 'lt-good');

        res.tests.forEach(function (t) {
            var tr = document.createElement('tr');
            tr.className = t.skipped ? 'lt-skipped' : (t.violated ? 'lt-violated' : 'lt-ok');
            var pCell = function (p) { return p < 0.001 ? '< .001' : p.toFixed(3).replace(/^0\./, '.'); };
            var cells = t.skipped
                ? [implText(t.imp), '', '', '', '', '', 'not tested — ' + t.skipped]
                : [implText(t.imp), f2(t.estimate), f2(t.lo) + ' to ' + f2(t.hi), pCell(t.p),
                   pCell(t.pHolm), String(t.n), t.violated ? 'violated' : 'consistent'];
            cells.forEach(function (c, i) {
                var td = document.createElement(i === 0 ? 'th' : 'td');
                if (i === 0) td.scope = 'row';
                td.textContent = c;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        wrap.style.display = '';
    }

    function useInMethods() {
        var res = window.LocalTests.last;
        if (!res || !window.MethodsExport) return;
        MethodsExport.setLocalTestResults(methodsSentence(res));
        setStatus('Added to "Assumptions for your paper" — the placeholder now reports these results.', 'success');
        if (window.Workspace && Workspace.toast) Workspace.toast('Methods statement updated with the test results.', 'ok');
    }

    function copyTable() {
        var res = window.LocalTests.last;
        if (!res) return;
        var tsv = toTSV(res);
        var done = function (ok) { setStatus(ok ? 'Table copied (tab-separated).' : 'Could not copy automatically.', ok ? 'success' : 'error'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(function () { done(true); }, function () { done(false); });
        else done(false);
    }

    function open() {
        if (!window.Model || !Model.dag) return;
        ensureRoot();
        state = state || {};
        root.style.display = 'flex';
        var g = Model.dag;
        var imps = implicationsOf(g);
        if (!imps.list.length) {
            setStatus('This diagram implies no testable independencies' +
                (imps.droppedSelection ? ' apart from ones involving the selection variable' : '') +
                ', so there is nothing to test.', 'warning');
        } else if (!state.table) {
            setStatus(imps.list.length + ' implied independenc' + (imps.list.length !== 1 ? 'ies' : 'y') + ' to test. Choose a data file.', '');
        }
        renderMapping();
        if (state.table) root.querySelector('#lt-run').disabled = false;
        setTimeout(function () { var f = root.querySelector('#lt-file'); if (f) f.focus(); }, 40);
    }
    function close() { if (root) root.style.display = 'none'; }

    window.LocalTests = {
        open: open, close: close, run: run, last: null,
        fisherTest: fisherTest, holm: holm, autoMap: autoMap, implicationsOf: implicationsOf,
        partialFromColumns: partialFromColumns, methodsSentence: methodsSentence, toTSV: toTSV, implText: implText
    };

    window.addEventListener('load', function () {
        if (window.DAGittyControl) DAGittyControl.observe('graphchange', function () {
            if (root && root.style.display === 'flex') renderMapping();
        });
    });

})();
