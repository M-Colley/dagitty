/* DAGitty UI Enhancements
 * Loaded after main.js — overrides/augments without touching main.js.
 */

(function () {
    'use strict';

    // ── Utility ───────────────────────────────────────────────────────────────

    function _escHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ── 1. Undo / Redo ────────────────────────────────────────────────────────

    var UndoRedo = {
        stack: [],
        future: [],
        MAX: 100,
        _paused: false,

        push: function () {
            if (this._paused) return;
            if (!window.Model || !Model.dag) return;
            var code = Model.dag.toString();
            if (this.stack.length && this.stack[this.stack.length - 1] === code) return;
            this.stack.push(code);
            if (this.stack.length > this.MAX) this.stack.shift();
            this.future = [];
            this._updateButtons();
        },

        undo: function () {
            if (this.stack.length < 2) return;
            var current = this.stack.pop();
            this.future.push(current);
            this._applyState(this.stack[this.stack.length - 1]);
            this._updateButtons();
        },

        redo: function () {
            if (!this.future.length) return;
            var next = this.future.pop();
            this.stack.push(next);
            this._applyState(next);
            this._updateButtons();
        },

        _applyState: function (code) {
            this._paused = true;
            try { _loadCodeIntoCanvas(code); }
            finally { this._paused = false; }
        },

        _updateButtons: function () {
            var u = document.getElementById('btn-undo');
            var r = document.getElementById('btn-redo');
            if (u) u.disabled = this.stack.length < 2;
            if (r) r.disabled = !this.future.length;
        }
    };

    function _loadCodeIntoCanvas(code) {
        var ta = document.getElementById('adj_matrix');
        if (ta) { ta.value = code; ta.style.backgroundColor = ''; }
        displayHide('model_refresh');
        var g = GraphParser.parseGuess(code);
        if (!g.hasCompleteLayout()) {
            var lay = new GraphLayouter.Spring(g);
            lay.layout();
        }
        DAGittyControl.setGraph(g);
    }

    // ── 2. Plain-language output ──────────────────────────────────────────────

    var _origDisplayAdjustmentInfo = null;
    var _origDisplayImplicationInfo = null;

    var PLAIN = [
        [/Minimal sufficient adjustment sets[^:]*for estimating the total effect of ([^:]+):/gi,
         'To estimate the total effect of $1, control for:'],
        [/Minimal sufficient adjustment sets[^:]*for estimating the direct effect of ([^:]+):/gi,
         'To estimate the direct effect of $1, control for:'],
        [/No adjustment is necessary to estimate the (total|direct) effect of ([^.]+)\./gi,
         'No control variables needed — the $1 effect of $2 can be estimated without adjustment.'],
        [/No adjustment sets found\./gi,
         'No valid adjustment set exists. The effect may not be identifiable from this diagram.'],
        [/Biasing paths are open\./gi,
         'Confounding detected — a naive comparison will be biased.'],
        [/No open biasing paths\./gi,
         'No confounding detected — no adjustment needed.'],
        [/Correctly adjusted\./gi,
         'Your chosen controls successfully block all confounding.'],
        [/Incorrectly adjusted\./gi,
         'Your chosen controls do NOT fully block confounding.'],
        [/No exposure defined\./gi,
         'Mark a variable as exposure first (click it, check "exposure").'],
        [/No outcome defined\./gi,
         'Mark a variable as outcome first (click it, check "outcome").'],
    ];

    function _plainifyEl(el) {
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        var nodes = [];
        var n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(function (node) {
            var t = node.textContent;
            PLAIN.forEach(function (p) { t = t.replace(p[0], p[1]); });
            node.textContent = t;
        });
    }

    function _enhancedDisplayAdjustmentInfo(kind) {
        if (_origDisplayAdjustmentInfo) _origDisplayAdjustmentInfo(kind);
        var el = document.getElementById('causal_effect');
        if (el) _plainifyEl(el);
    }

    function _enhancedDisplayImplicationInfo(full) {
        if (_origDisplayImplicationInfo) _origDisplayImplicationInfo(full);
        var el = document.getElementById('testable_implications');
        if (!el) return;
        if (!el.querySelector('.impl-explainer')) {
            var intro = document.createElement('p');
            intro.className = 'impl-explainer';
            intro.textContent = 'Statistical patterns your diagram predicts. ' +
                'Violations in your data suggest a mis-specified model.';
            el.insertBefore(intro, el.firstChild);
        }
        el.querySelectorAll('li').forEach(function (li) {
            var t = li.textContent.trim();
            var m = t.match(/^(.+?)\s*⊥\s*(.+?)\s*\|\s*(.+)$/);
            if (m) li.title = m[1].trim() + ' is independent of ' + m[2].trim() + ' when controlling for ' + m[3].trim();
            else {
                var m2 = t.match(/^(.+?)\s*⊥\s*(.+)$/);
                if (m2) li.title = m2[1].trim() + ' is independent of ' + m2[2].trim();
            }
        });
    }

    // ── 3. Chevron arrows (replace PNG-based displayArrow) ────────────────────

    window.displayArrow = function (id, on) {
        var el = document.getElementById('a_' + id);
        if (!el) return;
        if (el.tagName === 'IMG') {
            // legacy fallback
            el.src = 'images/arrow-' + (on ? 'down' : 'right') + '.png';
        } else {
            el.dataset.open = on ? '1' : '0';
        }
    };

    // ── 4. Beginner / Advanced mode ───────────────────────────────────────────

    var BeginnerMode = {
        active: false,
        KEY: 'dagitty_beginner_mode',
        HIDDEN: ['viewmode', 'effects', 'dagstyle'],
        COLLAPSED: ['model_data'],

        init: function () {
            this.active = localStorage.getItem(this.KEY) === 'true';
            this._apply();
        },

        toggle: function () {
            this.active = !this.active;
            localStorage.setItem(this.KEY, this.active);
            this._apply();
        },

        _apply: function () {
            var btn = document.getElementById('btn-beginner-mode');
            if (this.active) {
                document.body.classList.add('beginner-mode');
                if (btn) { btn.textContent = 'Advanced mode'; btn.setAttribute('aria-pressed', 'true'); }
                this.HIDDEN.forEach(function (id) {
                    var c = document.getElementById(id), h = _getSectionHeader(id);
                    if (c) c.style.display = 'none';
                    if (h) h.style.display = 'none';
                });
                this.COLLAPSED.forEach(function (id) { displayHide(id); });
                displayShow('quickstart');
            } else {
                document.body.classList.remove('beginner-mode');
                if (btn) { btn.textContent = 'Beginner mode'; btn.setAttribute('aria-pressed', 'false'); }
                this.HIDDEN.forEach(function (id) {
                    var c = document.getElementById(id), h = _getSectionHeader(id);
                    if (c) c.style.display = 'block';
                    if (h) h.style.display = '';
                });
                this.COLLAPSED.forEach(function (id) { displayShow(id); });
            }
        }
    };

    // ── 4b. Light / dark theme toggle ─────────────────────────────────────────
    // The effective theme is set on <html data-theme> by an inline script in the
    // page <head> (before CSS loads, to avoid a flash). Here we just flip it and
    // keep the toolbar button in sync.

    var ThemeToggle = {
        KEY: 'dagitty_theme',

        current: function () {
            return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        },

        set: function (theme, persist) {
            document.documentElement.setAttribute('data-theme', theme);
            if (persist !== false) {
                try { localStorage.setItem(this.KEY, theme); } catch (e) {}
            }
            this._sync();
        },

        toggle: function () {
            this.set(this.current() === 'dark' ? 'light' : 'dark');
        },

        _sync: function () {
            var icon = document.getElementById('btn-theme-icon');
            var label = document.getElementById('btn-theme-label');
            var btn = document.getElementById('btn-theme');
            var isDark = this.current() === 'dark';
            // Show what you'll switch TO (the common toggle convention).
            if (icon) icon.textContent = isDark ? '☀' : '🌙';
            if (label) label.textContent = isDark ? 'Light' : 'Dark';
            if (btn) btn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
        },

        init: function () {
            this._sync();
            // If the user has not made an explicit choice, keep following the OS.
            var stored;
            try { stored = localStorage.getItem(this.KEY); } catch (e) { stored = null; }
            if (stored !== 'light' && stored !== 'dark' && window.matchMedia) {
                var mq = window.matchMedia('(prefers-color-scheme: dark)');
                var self = this;
                var onChange = function (e) { self.set(e.matches ? 'dark' : 'light', false); };
                if (mq.addEventListener) mq.addEventListener('change', onChange);
                else if (mq.addListener) mq.addListener(onChange);
            }
        }
    };

    function _getSectionHeader(id) {
        var h3s = document.querySelectorAll('h3');
        for (var i = 0; i < h3s.length; i++) {
            var oc = h3s[i].getAttribute('onclick') || '';
            if (oc.indexOf("'" + id + "'") !== -1 || oc.indexOf('"' + id + '"') !== -1) return h3s[i];
        }
        return null;
    }

    // ── 5. Empty-state canvas hint ────────────────────────────────────────────

    function updateCanvasHint(g) {
        var hint = document.getElementById('canvas-hint');
        if (!hint) return;
        var empty = !g || g.getNumberOfVertices() === 0;
        hint.style.display = empty ? 'flex' : 'none';
    }

    // ── 6. Download model ─────────────────────────────────────────────────────

    window.downloadModel = function () {
        var code = document.getElementById('adj_matrix').value || '';
        var blob = new Blob([code], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'dagitty-model.dag';
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    // ── 7. Menu keyboard navigation ───────────────────────────────────────────

    function initMenuKeyboard() {
        var menu = document.getElementById('menu');
        if (!menu) return;
        var topItems = Array.prototype.filter.call(menu.children, function (li) { return li.querySelector('ul'); });

        document.addEventListener('click', function (e) {
            if (!e.target.closest || !e.target.closest('#menu')) {
                menu.querySelectorAll('li ul').forEach(function (ul) { ul.style.display = ''; });
            }
        });

        topItems.forEach(function (li, idx) {
            var link = li.querySelector(':scope > a');
            if (!link) return;
            link.setAttribute('tabindex', '0');
            link.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowRight') { e.preventDefault(); (topItems[(idx+1)%topItems.length].querySelector(':scope>a')||{focus:function(){}}).focus(); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); (topItems[(idx-1+topItems.length)%topItems.length].querySelector(':scope>a')||{focus:function(){}}).focus(); }
                else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    var ul = li.querySelector('ul');
                    if (ul) { ul.style.display = 'block'; var f = ul.querySelector('a'); if (f) f.focus(); }
                } else if (e.key === 'Escape') {
                    menu.querySelectorAll('li ul').forEach(function(ul){ul.style.display='';});
                }
            });
            var ul = li.querySelector('ul');
            if (!ul) return;
            var subs = Array.prototype.slice.call(ul.querySelectorAll('a'));
            subs.forEach(function (sub, si) {
                sub.addEventListener('keydown', function (e) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); (subs[(si+1)%subs.length]).focus(); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); if(si===0){ul.style.display='';link.focus();}else subs[si-1].focus(); }
                    else if (e.key === 'Escape' || e.key === 'Tab') { ul.style.display=''; link.focus(); }
                });
            });
        });
    }

    // ── 8. Data Discovery Modal ───────────────────────────────────────────────

    window.DataModal = {
        _csvText: null,
        _resultCode: null,

        open: function () {
            var modal = document.getElementById('data-discovery-modal');
            if (!modal) return;
            this._csvText = null; this._resultCode = null;
            document.getElementById('data-csv-input').value = '';
            this._setStatus('', '');
            var p = document.getElementById('data-modal-preview');
            if (p) p.style.display = 'none';
            var vs = document.getElementById('data-var-select');
            if (vs) vs.style.display = 'none';
            var dl = document.getElementById('btn-download-model');
            if (dl) dl.style.display = 'none';
            document.getElementById('btn-run-analysis').disabled = true;
            document.getElementById('btn-import-dag').disabled = true;
            modal.style.display = 'flex';
            modal.onclick = function (e) { if (e.target === modal) DataModal.close(); };
            setTimeout(function () { var fi = document.getElementById('data-csv-input'); if (fi) fi.focus(); }, 50);
        },

        close: function () {
            if (this._worker) { this._worker.terminate(); this._worker = null; }
            var modal = document.getElementById('data-discovery-modal');
            if (modal) modal.style.display = 'none';
        },

        /** Called after CSV text is ready — runs parseCSV to show variable selector. */
        _onCsvReady: function (fileName, rowHint) {
            var self = this;
            var parsed;
            try { parsed = CausalDiscovery.parseCSV(this._csvText); }
            catch (e) {
                // parseCSV can throw on truly bad files; show error and still enable run
                this._setStatus('Loaded ' + fileName + ' (' + rowHint + ' rows). ' +
                    'Warning: ' + e.message, 'warning');
                document.getElementById('btn-run-analysis').disabled = false;
                return;
            }
            this._showVarSelect(parsed);
            var kept = parsed.headers.length, dropped = parsed.droppedCols.length;
            var msg = 'Loaded ' + fileName + ' \u2014 ' + rowHint + ' rows, ' +
                kept + ' variable' + (kept !== 1 ? 's' : '') + ' detected';
            if (dropped) msg += ', ' + dropped + ' column' + (dropped !== 1 ? 's' : '') + ' skipped';
            msg += '. Adjust selection then click Run Analysis.';
            this._setStatus(msg, 'success');
            document.getElementById('btn-run-analysis').disabled = false;
        },

        /** Render the variable-selection checkbox grid. */
        _showVarSelect: function (parsed) {
            var wrap = document.getElementById('data-var-select');
            var list = document.getElementById('data-var-list');
            if (!wrap || !list) return;
            list.innerHTML = '';

            parsed.headers.forEach(function (h) {
                var lbl = document.createElement('label');
                var cb  = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = true;
                cb.dataset.varname = h;
                lbl.appendChild(cb);
                lbl.appendChild(document.createTextNode('\u00A0' + h));
                lbl.title = h;
                list.appendChild(lbl);
            });

            // Show dropped columns greyed-out (informational, no checkbox)
            parsed.droppedCols.forEach(function (d) {
                var lbl = document.createElement('label');
                lbl.className = 'var-dropped';
                lbl.textContent = d.replace(/ \(.*/, ''); // strip reason for brevity
                lbl.title = d;
                list.appendChild(lbl);
            });

            wrap.style.display = parsed.headers.length ? '' : 'none';
        },

        handleFile: function (file) {
            if (!file) return;
            this._csvText = null; this._resultCode = null;
            document.getElementById('btn-run-analysis').disabled = true;
            document.getElementById('btn-import-dag').disabled = true;
            var vs = document.getElementById('data-var-select');
            if (vs) vs.style.display = 'none';
            var dl = document.getElementById('btn-download-model');
            if (dl) dl.style.display = 'none';

            var ext = file.name.split('.').pop().toLowerCase();
            var self = this;

            // Pickle: browser can't parse Python binary format
            if (ext === 'pkl' || ext === 'pickle') {
                this._setStatus(
                    'Python pickle files cannot be read in the browser. ' +
                    'Export to CSV first: df.to_csv("data.csv", index=False)', 'error');
                return;
            }

            // Excel: load SheetJS lazily, then convert to CSV
            if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsb' || ext === 'ods') {
                this._setStatus('Loading Excel support\u2026', 'running');
                _loadSheetJS(function (ok) {
                    if (!ok) { self._setStatus('Failed to load Excel library. Try saving as CSV instead.', 'error'); return; }
                    var reader = new FileReader();
                    reader.onload = function (e) {
                        try {
                            var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
                            var ws = wb.Sheets[wb.SheetNames[0]];
                            self._csvText = XLSX.utils.sheet_to_csv(ws);
                            var rows = self._csvText.trim().split('\n').length - 1;
                            self._onCsvReady('sheet "' + wb.SheetNames[0] + '"', rows);
                        } catch (err) {
                            self._setStatus('Error reading Excel: ' + err.message, 'error');
                        }
                    };
                    reader.readAsArrayBuffer(file);
                });
                return;
            }

            // CSV / TSV / TXT
            this._setStatus('Reading file\u2026', 'running');
            var reader = new FileReader();
            reader.onload = function (e) {
                self._csvText = e.target.result;
                var rows = self._csvText.trim().split(/\r?\n/).length - 1;
                self._onCsvReady(file.name, rows);
            };
            reader.onerror = function () { self._setStatus('Could not read file.', 'error'); };
            reader.readAsText(file);
        },

        _worker: null,

        _handleResult: function (result) {
            this._resultCode = result.modelCode;
            this._setProgress(100, 'Analysis complete.');

            var msg = 'Found ' + result.edgeCount + ' edge(s) among ' +
                result.nodeCount + ' variables (' + result.n + ' observations).';
            if (result.undirectedCount > 0)
                msg += ' ' + result.undirectedCount + ' edge(s) shown as \u2194 (direction ambiguous).';

            this._setStatus(msg, 'success');
            this._showPreview(result);

            result.warnings.forEach(function (w) {
                var p = document.createElement('p');
                p.className = 'warning';
                p.textContent = '\u26A0 ' + w;
                document.getElementById('data-modal-status').appendChild(p);
            });

            document.getElementById('btn-import-dag').disabled    = false;
            document.getElementById('btn-run-analysis').disabled  = false;
            document.getElementById('btn-cancel-analysis').style.display = 'none';
            document.getElementById('btn-download-model').style.display = '';
        },

        _handleError: function (message) {
            this._setStatus('Error: ' + message, 'error');
            document.getElementById('btn-run-analysis').disabled = false;
            document.getElementById('btn-cancel-analysis').style.display = 'none';
        },

        /** Fallback: run on main thread if Web Worker is unavailable. */
        _runOnMainThread: function (csvText, alpha, useLingam, opts) {
            var self = this;
            CausalDiscovery.discoverFromCSVAsync(
                csvText, alpha, useLingam,
                function (pct, label) { self._setProgress(pct, label); },
                opts
            ).then(function (result) {
                self._handleResult(result);
            }).catch(function (err) {
                self._handleError(err.message);
            });
        },

        runAnalysis: function () {
            if (!this._csvText) return;
            var alpha     = parseFloat(document.getElementById('data-alpha').value) || 0.05;
            var useLingam = document.getElementById('data-use-lingam').checked;
            var speedEl   = document.getElementById('data-speed');
            var speed     = speedEl ? speedEl.value : 'standard';
            var opts      = speed === 'fast'     ? { maxCondSize: 2, corrThreshold: 0.08 }
                          : speed === 'thorough' ? { maxCondSize: 5, corrThreshold: 0.02 }
                          :                        { maxCondSize: 3, corrThreshold: 0.05 };

            // Collect any variables unchecked by the user
            var excludeVars = [];
            var cbs = document.querySelectorAll('#data-var-list input[type="checkbox"]');
            for (var ci = 0; ci < cbs.length; ci++) {
                if (!cbs[ci].checked) excludeVars.push(cbs[ci].dataset.varname);
            }
            if (excludeVars.length) opts.excludeVars = excludeVars;

            var self = this;

            document.getElementById('btn-run-analysis').disabled = true;
            document.getElementById('btn-import-dag').disabled   = true;
            document.getElementById('btn-download-model').style.display = 'none';
            this._setProgress(0, 'Starting\u2026');

            // Prefer Web Worker (keeps UI fully responsive); fall back to main thread
            if (typeof Worker !== 'undefined') {
                if (this._worker) this._worker.terminate();
                try {
                    this._worker = new Worker('js/causal-discovery.js');
                } catch (e) {
                    this._worker = null;
                    this._runOnMainThread(this._csvText, alpha, useLingam, opts);
                    return;
                }
                var w = this._worker;
                w.onmessage = function (e) {
                    var msg = e.data;
                    if (msg.type === 'progress') self._setProgress(msg.pct, msg.label);
                    else if (msg.type === 'done')  { self._worker = null; self._handleResult(msg.result); }
                    else if (msg.type === 'error') { self._worker = null; self._handleError(msg.message); }
                };
                w.onerror = function () {
                    // Worker failed (CORS, CSP, etc.) — fall back to main thread
                    self._worker = null;
                    self._runOnMainThread(self._csvText, alpha, useLingam, opts);
                };
                w.postMessage({
                    type:      'analyze',
                    csvText:   this._csvText,
                    alpha:     alpha,
                    useLingam: useLingam,
                    opts:      opts
                });
                document.getElementById('btn-cancel-analysis').style.display = '';
            } else {
                this._runOnMainThread(this._csvText, alpha, useLingam, opts);
            }
        },

        cancelAnalysis: function () {
            if (this._worker) {
                this._worker.terminate();
                this._worker = null;
            }
            this._setStatus('Analysis cancelled.', 'warning');
            document.getElementById('btn-run-analysis').disabled = false;
            document.getElementById('btn-cancel-analysis').style.display = 'none';
        },

        importDAG: function () {
            if (!this._resultCode) return;
            _loadCodeIntoCanvas(this._resultCode);
            this.close();
            if (window.generateSpringLayout) generateSpringLayout();
        },

        downloadModel: function () {
            if (!this._resultCode) return;
            var blob = new Blob([this._resultCode], { type: 'text/plain' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href = url; a.download = 'discovered-dag.dagitty';
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        },

        _setStatus: function (msg, type) {
            var el = document.getElementById('data-modal-status');
            if (!el) return;
            // Remove progress bar if present, revert to plain text status
            el.innerHTML = '';
            el.className = 'modal-status' + (type ? ' status-' + type : '');
            el.textContent = msg;
        },

        _setProgress: function (pct, label) {
            var el = document.getElementById('data-modal-status');
            if (!el) return;
            el.className = 'modal-status status-running';
            el.innerHTML =
                '<div class="progress-label">' + _escHtml(label) + '</div>' +
                '<div class="progress-track">' +
                  '<div class="progress-bar" style="width:' + Math.round(pct) + '%"></div>' +
                '</div>' +
                '<div class="progress-pct">' + Math.round(pct) + '%</div>';
        },

        _showPreview: function (result) {
            var preview = document.getElementById('data-modal-preview');
            var content = document.getElementById('data-modal-preview-content');
            if (!preview || !content) return;
            content.innerHTML = '';

            // Build variable-index lookup for correlation strengths
            var varIdx = {};
            if (result.vars) {
                result.vars.forEach(function (v, i) { varIdx[v] = i; });
            }

            var edges = result.modelCode.split('\n').filter(function (l) {
                return l.indexOf('->') !== -1 || l.indexOf('<->') !== -1;
            });

            if (!edges.length) {
                var empty = document.createElement('p');
                empty.style.color = 'var(--muted)';
                empty.style.fontSize = '12px';
                empty.textContent = 'No edges found \u2014 try a less strict significance level.';
                content.appendChild(empty);
            } else {
                edges.forEach(function (line) {
                    line = line.trim();
                    var d = document.createElement('div');
                    d.className = 'modal-preview-edge';

                    // Extract variable names from "A -> B" or "A <-> B".
                    // Sources may be quoted ("my var") or bare; a lazy source
                    // token keeps "->"/"<->" from being swallowed into the name.
                    var m = line.match(/^\s*(?:"([^"]+)"|([^\s"]+?))\s*(->|<->)\s*(?:"([^"]+)"|([^\s"[]+))/);
                    var badge = '';
                    if (m && result.corrMat && result.vars) {
                        var a = (m[1] || m[2]).trim(), b = (m[4] || m[5]).trim();
                        var ai = varIdx[a], bi = varIdx[b];
                        if (ai !== undefined && bi !== undefined) {
                            var r = Math.abs(result.corrMat[ai][bi]);
                            var cls = r >= 0.5 ? 'strong' : r >= 0.3 ? 'moderate' : 'weak';
                            var lbl = r >= 0.5 ? 'strong' : r >= 0.3 ? 'moderate' : 'weak';
                            badge = '<span class="edge-strength ' + cls + '" title="|r| = ' +
                                r.toFixed(2) + '">' + lbl + '</span>';
                        }
                    }

                    d.innerHTML = _escHtml(line) + badge;
                    content.appendChild(d);
                });
            }
            preview.style.display = 'block';
        }
    };

    function _loadSheetJS(cb) {
        if (window.XLSX) { cb(true); return; }
        var s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = function () { cb(true); };
        s.onerror = function () { cb(false); };
        document.head.appendChild(s);
    }

    // ── 8b. Tooltips ──────────────────────────────────────────────────────────
    // The "?" help badges previously relied on the native `title` tooltip, which
    // is slow, unstyled, and unreliable across browsers. Replace it with a small
    // styled popover shown on hover and keyboard focus.

    function initTooltips() {
        var tip = null;
        function ensure() {
            if (!tip) {
                tip = document.createElement('div');
                tip.className = 'app-tooltip';
                tip.setAttribute('role', 'tooltip');
                document.body.appendChild(tip);
            }
            return tip;
        }
        function textFor(el) {
            if (el.getAttribute('data-tip') != null) return el.getAttribute('data-tip');
            var t = el.getAttribute('title');
            if (t != null) {
                el.setAttribute('data-tip', t);
                el.removeAttribute('title');           // suppress the native tooltip
                if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', t);
                if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
                return t;
            }
            return '';
        }
        function show(el) {
            var txt = textFor(el);
            if (!txt) return;
            var t = ensure();
            t.textContent = txt;
            t.style.display = 'block';
            t.style.left = '0'; t.style.top = '0';
            var r = el.getBoundingClientRect(), tw = t.offsetWidth, th = t.offsetHeight, gap = 8;
            var left = r.left + r.width / 2 - tw / 2;
            var top = r.bottom + gap;
            if (top + th > window.innerHeight - 4) top = r.top - gap - th;
            left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
            t.style.left = left + 'px'; t.style.top = top + 'px';
            t.classList.add('on');
        }
        function hide() { if (tip) { tip.classList.remove('on'); tip.style.display = 'none'; } }

        var sel = '.help-tip';
        document.addEventListener('mouseover', function (e) { var el = e.target.closest && e.target.closest(sel); if (el) show(el); });
        document.addEventListener('mouseout',  function (e) { var el = e.target.closest && e.target.closest(sel); if (el) hide(); });
        document.addEventListener('focusin',   function (e) { var el = e.target.closest && e.target.closest(sel); if (el) show(el); });
        document.addEventListener('focusout',  function (e) { var el = e.target.closest && e.target.closest(sel); if (el) hide(); });
        document.addEventListener('keydown',   function (e) { if (e.key === 'Escape') hide(); });

        // Pre-convert existing badges so the native tooltip never appears and
        // they're keyboard-focusable.
        document.querySelectorAll('.help-tip[title]').forEach(textFor);
    }

    // ── 8c. Export model as R code (dagitty / ggdag) ──────────────────────────

    window.exportRCode = function () {
        var code = (window.Model && Model.dag) ? Model.dag.toString() : 'dag { }';
        var r =
            '# DAG exported from DAGitty — reproduce and analyse in R\n' +
            'library(dagitty)\n\n' +
            'g <- dagitty(\'' + code + '\')\n\n' +
            'plot(g)\n\n' +
            '# Tidyverse-friendly plotting & analysis with ggdag:\n' +
            '# library(ggdag)\n' +
            '# ggdag(g) + theme_dag()\n' +
            '# ggdag_adjustment_set(g)            # minimal sufficient adjustment set(s)\n' +
            '# impliedConditionalIndependencies(g)\n' +
            '# localTests(g, data = your_data)    # test those implications against data\n';
        if (window.DAGittyControl && DAGittyControl.getView) {
            DAGittyControl.getView().openHTMLDialog(
                '<p style="margin:.2em 0 .5em;font-size:12px">R code (uses the <code>dagitty</code> package; ' +
                'works directly with <code>ggdag</code>). Copy it into your script:</p>' +
                '<textarea style="width:92%" rows="12" readonly onclick="this.select()">' +
                _escHtml(r) + '</textarea>', 'OK');
        }
    };

    // ── 9. Undo/Redo keyboard handler ─────────────────────────────────────────

    function initUndoRedoKeys() {
        // Wrap document.onkeydown that initialize() set
        var _orig = document.onkeydown;
        document.onkeydown = function (e) {
            var mod = e.ctrlKey || e.metaKey;
            if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); UndoRedo.undo(); return; }
            if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); UndoRedo.redo(); return; }
            if (_orig) _orig.call(document, e);
        };
    }

    // ── 10. Post-init (runs after initialize()) ───────────────────────────────

    // KEY FIX: use addEventListener instead of wrapping window.onload,
    // which would be overwritten by the inline script that sets window.onload = initialize.
    window.addEventListener('load', function _postInit() {
        // Capture originals before overriding
        _origDisplayAdjustmentInfo  = window.displayAdjustmentInfo;
        _origDisplayImplicationInfo = window.displayImplicationInfo;
        window.displayAdjustmentInfo  = _enhancedDisplayAdjustmentInfo;
        window.displayImplicationInfo = _enhancedDisplayImplicationInfo;

        // initialize() already rendered the analysis panels once, using the
        // ORIGINAL functions (this load handler runs after window.onload=initialize).
        // Re-render now so the very first view is also plain-language rewritten.
        try {
            var kindEl = document.getElementById('causal_effect_kind');
            if (window.causalEffectEstimates && kindEl) causalEffectEstimates(kindEl.value);
            if (window.displayImplicationInfo) displayImplicationInfo(false);
        } catch (e) { /* non-fatal: panels will rewrite on first edit */ }

        if (window.DAGittyControl) {
            DAGittyControl.observe('graphchange', function (g) {
                UndoRedo.push();
                updateCanvasHint(g);
            });
        }

        initUndoRedoKeys();
        initMenuKeyboard();
        initTooltips();
        BeginnerMode.init();
        ThemeToggle.init();

        // Rename "selected" label
        var lbl = document.querySelector('label[for="variable_selected"]');
        if (lbl) {
            for (var i = 0; i < lbl.childNodes.length; i++) {
                if (lbl.childNodes[i].nodeType === Node.TEXT_NODE) {
                    lbl.childNodes[i].textContent = 'sample selection'; break;
                }
            }
        }

        // Push initial state so first undo is available
        setTimeout(function () {
            if (window.Model && Model.dag) {
                UndoRedo.push();
                updateCanvasHint(Model.dag);
            }
        }, 100);
    });

    // Expose for HTML onclick handlers
    window.BeginnerMode = BeginnerMode;
    window.UndoRedo = UndoRedo;
    window.ThemeToggle = ThemeToggle;

})();
