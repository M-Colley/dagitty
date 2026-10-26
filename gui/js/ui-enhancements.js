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
            if (window.modelCodeIsPending && modelCodeIsPending()) return;
            if (this.stack.length < 2) return;
            var current = this.stack.pop();
            this.future.push(current);
            this._applyState(this.stack[this.stack.length - 1]);
            this._updateButtons();
        },

        redo: function () {
            if (window.modelCodeIsPending && modelCodeIsPending()) return;
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
        // Parse before touching the code editor so an invalid import cannot
        // overwrite a draft while leaving the previous diagram on the canvas.
        var g = GraphParser.parseGuess(code);
        var ta = document.getElementById('adj_matrix');
        if (ta) { ta.value = code; ta.style.backgroundColor = ''; ta.classList.remove('dirty'); }
        displayHide('model_refresh');
        if (!g.hasCompleteLayout()) {
            var lay = new GraphLayouter.Spring(g);
            lay.layout();
        }
        DAGittyControl.setGraph(g);
    }

    // ── 2. Plain-language output ──────────────────────────────────────────────

    var _origDisplayAdjustmentInfo = null;
    var _origDisplayImplicationInfo = null;

    // ── 2a. What SHOULD be adjusted for? ──────────────────────────────────────
    // GraphAnalyzer.listMsas*Effect() treats every node already marked
    // "adjusted" as mandatory: it lists only the sufficient sets that CONTAIN
    // them, and returns nothing at all if one of them may not be adjusted for
    // (a mediator, say). The upstream panel is careful to say "sets containing
    // Z", but any paraphrase that drops that qualifier — as the plain-language
    // rules below did, and as the methods statement did — turns "no set
    // containing your mediator exists" into "the effect is not identifiable",
    // which is simply false. So compute the unconstrained answer on a copy of
    // the graph with the current adjustments cleared, and show both.
    window.AdjustmentSets = {
        /** Minimal sufficient sets ignoring the user's current adjustments, as
         *  sorted arrays of ids; [] = none exists; [[]] = nothing needed;
         *  null = not applicable (no exposure/outcome, unsupported graph). */
        minimal: function (g, kind) {
            if (!g || !g.getSources().length || !g.getTargets().length) return null;
            var h = g.clone();
            h.getAdjustedNodes().slice().forEach(function (v) { h.removeAdjustedNode(v); });
            try {
                var sets = kind === 'direct' ? GraphAnalyzer.listMsasDirectEffect(h)
                                             : GraphAnalyzer.listMsasTotalEffect(h);
                return sets.map(function (s) { return _.pluck(s, 'id').sort(); });
            } catch (e) { return null; }
        },
        /** Is the user's current adjustment set exactly one of `sets`? */
        isOneOf: function (g, sets) {
            var cur = _.pluck(g.getAdjustedNodes(), 'id').sort();
            return (sets || []).some(function (s) {
                return s.length === cur.length && s.every(function (x, i) { return x === cur[i]; });
            });
        }
    };

    function _setsList(sets) {
        var ul = document.createElement('ul');
        sets.slice().sort().forEach(function (s) {
            var li = document.createElement('li');
            li.textContent = s.join(', ');
            ul.appendChild(li);
        });
        return ul;
    }

    /** Extra paragraph for the causal-effect panel when the user has adjusted
     *  for something: what the minimal sets are WITHOUT that constraint. */
    function _unconstrainedNote(g, kind) {
        var adjusted = _.pluck(g.getAdjustedNodes(), 'id').sort();
        if (!adjusted.length || g.getSelectedNodes().length) return null;
        var sets = AdjustmentSets.minimal(g, kind);
        if (!sets) return null;
        var label = kind + ' effect';
        var sufficient = kind === 'direct' ? GraphAnalyzer.isAdjustmentSetDirectEffect(g)
                                           : GraphAnalyzer.isAdjustmentSet(g);
        var wrap = document.createElement('div');
        wrap.className = 'adj-alt';
        var p = document.createElement('p');
        wrap.appendChild(p);
        if (!sets.length) {
            p.textContent = 'No choice of controls identifies the ' + label + ' in this diagram — ' +
                'adjustment alone cannot recover it.';
        } else if (sets.length === 1 && sets[0].length === 0) {
            p.textContent = (sufficient ? 'None of these controls is actually needed: '
                                        : 'Remove ' + (adjusted.length > 1 ? 'these controls' : 'this control') + ' instead: ') +
                'the ' + label + ' can be estimated without any adjustment.';
        } else if (AdjustmentSets.isOneOf(g, sets)) {
            return null;                          // already minimal — nothing to add
        } else {
            p.textContent = sufficient
                ? 'A smaller set would also do. Ignoring your current choice, the minimal sufficient sets are:'
                : 'Sets that would work instead (ignoring your current choice):';
            wrap.appendChild(_setsList(sets));
        }
        return wrap;
    }

    var PLAIN = [
        // The upstream text is honest about the constraint ("sets containing Z");
        // keep that qualifier rather than presenting a constrained list as THE
        // answer.
        [/Minimal sufficient adjustment sets\s+containing ([^:]+?) for estimating the (total|direct) effect of ([^:]+):/gi,
         'Sufficient sets for the $2 effect of $3 that keep your current choice ($1):'],
        [/Minimal sufficient adjustment sets\s+for estimating the (total|direct) effect of ([^:]+):/gi,
         'To estimate the $1 effect of $2, control for:'],
        [/No adjustment is necessary to estimate the (total|direct) effect of ([^.]+)\./gi,
         'No control variables needed — the $1 effect of $2 can be estimated without adjustment.'],
        [/No adjustment sets found\./gi,
         'No valid adjustment set exists. The effect may not be identifiable from this diagram.'],
        // "Biasing path", not "confounding": an open path may be a back-door
        // path (confounding) or a collider path the user's own adjustment
        // opened. The Diagram check and Paths panels name the mechanism.
        [/Biasing paths are open\./gi,
         'An unadjusted comparison is not sufficient for this analysis under the diagram.'],
        [/No open biasing paths\./gi,
         'No control variables are needed for this analysis under the diagram.'],
        // \b is load-bearing: "Incorrectly adjusted." CONTAINS "correctly
        // adjusted.", so without it this rule fired inside the negative message
        // and turned it into "InYour chosen controls successfully block all
        // confounding." — telling the user their adjustment was fine at exactly
        // the moment it was not.
        [/\bCorrectly adjusted\./gi,
         'Your chosen controls are sufficient for this analysis under the diagram.'],
        [/\bIncorrectly adjusted\./gi,
         'Your chosen controls are not sufficient for this analysis under the diagram.'],
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

    // "No adjustment sets found." means something different once the user has
    // adjusted for something: not "the effect is unidentifiable" but "no
    // sufficient set includes everything you picked".
    var PLAIN_CONSTRAINED_EMPTY = [/No adjustment sets found\./gi,
        'No sufficient adjustment set includes all of your current controls.'];

    function _enhancedDisplayAdjustmentInfo(kind) {
        if (_origDisplayAdjustmentInfo) _origDisplayAdjustmentInfo(kind);
        var el = document.getElementById('causal_effect');
        if (!el) return;
        var g = (window.Model && Model.dag) ? Model.dag : null;
        var hasAdj = !!(g && g.getAdjustedNodes().length);
        if (hasAdj) {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false), n;
            while ((n = walker.nextNode()))
                n.textContent = n.textContent.replace(PLAIN_CONSTRAINED_EMPTY[0], PLAIN_CONSTRAINED_EMPTY[1]);
        }
        _plainifyEl(el);
        if (hasAdj && (kind === 'total' || kind === 'direct') && !GraphAnalyzer.containsCycle(g)) {
            var note = _unconstrainedNote(g, kind);
            if (note) el.appendChild(note);
        }
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
        // Every show/hide/toggle of a section passes through here, so it is the
        // one place to keep the header's aria-expanded state in sync too.
        var hdr = document.querySelector('h3[aria-controls="' + id + '"]');
        if (hdr) hdr.setAttribute('aria-expanded', on ? 'true' : 'false');
        var el = document.getElementById('a_' + id);
        if (!el) return;
        if (el.tagName === 'IMG') {
            // legacy fallback
            el.src = 'images/arrow-' + (on ? 'down' : 'right') + '.png';
        } else {
            el.dataset.open = on ? '1' : '0';
        }
    };

    // ── 3b. Keyboard-operable section headers ─────────────────────────────────
    // The collapsible <h3> headers only had an inline onclick, so they could not
    // be reached or operated from the keyboard at all, and screen readers had no
    // idea they were buttons or whether the section was open.
    function initSectionHeaders() {
        document.querySelectorAll('h3[onclick*="displayToggle"]').forEach(function (h) {
            var m = /displayToggle\(\s*['"]([^'"]+)['"]/.exec(h.getAttribute('onclick') || '');
            if (!m) return;
            var target = document.getElementById(m[1]);
            h.setAttribute('role', 'button');
            h.setAttribute('tabindex', '0');
            h.setAttribute('aria-controls', m[1]);
            h.setAttribute('aria-expanded', (target && getComputedStyle(target).display === 'none') ? 'false' : 'true');
            h.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.click(); }
            });
        });
    }

    // ── 4. Beginner / Advanced mode ───────────────────────────────────────────

    var BeginnerMode = {
        active: false,
        KEY: 'dagitty_beginner_mode',
        HIDDEN: ['viewmode', 'effects', 'dagstyle'],
        COLLAPSED: ['model_data'],

        init: function () {
            try { this.active = localStorage.getItem(this.KEY) === 'true'; } catch (e) { this.active = false; }
            this._apply();
        },

        toggle: function () {
            this.active = !this.active;
            try { localStorage.setItem(this.KEY, this.active); } catch (e) {}
            this._apply();
        },

        _apply: function () {
            var btn = document.getElementById('btn-beginner-mode');
            if (this.active) {
                document.body.classList.add('beginner-mode');
                if (btn) { btn.textContent = 'Beginner mode'; btn.setAttribute('aria-pressed', 'true'); }
                this.HIDDEN.forEach(function (id) {
                    var c = document.getElementById(id), h = _getSectionHeader(id);
                    if (c) c.style.display = 'none';
                    if (h) h.style.display = 'none';
                });
                this.COLLAPSED.forEach(function (id) { displayHide(id); });
                displayShow('quickstart');
            } else {
                document.body.classList.remove('beginner-mode');
                if (btn) { btn.textContent = 'Advanced mode'; btn.setAttribute('aria-pressed', 'false'); }
                this.HIDDEN.forEach(function (id) {
                    var c = document.getElementById(id), h = _getSectionHeader(id);
                    if (c) c.style.display = 'block';
                    if (h) h.style.display = '';
                });
                this.COLLAPSED.forEach(function (id) { displayShow(id); });
            }
            if (btn) {
                btn.setAttribute('aria-label', 'Beginner mode');
                btn.title = this.active ? 'Beginner mode is on. Switch to advanced mode.' : 'Advanced mode is on. Switch to beginner mode.';
            }
        }
    };

    // ── 4b. Light / dark theme toggle ─────────────────────────────────────────
    // The effective theme is set on <html data-theme> by an inline script in the
    // page <head> (before CSS loads, to avoid a flash). Here we just flip it and
    // keep the toolbar button in sync.

    var ThemeToggle = {
        KEY: 'dagitty_theme',
        _manual: false,

        current: function () {
            return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        },

        set: function (theme, persist) {
            document.documentElement.setAttribute('data-theme', theme);
            if (persist !== false) {
                this._manual = true;
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
            if (btn) btn.setAttribute('aria-label', btn.title);
        },

        init: function () {
            this._sync();
            // If the user has not made an explicit choice, keep following the OS.
            var stored;
            try { stored = localStorage.getItem(this.KEY); } catch (e) { stored = null; }
            this._manual = stored === 'light' || stored === 'dark';
            if (stored !== 'light' && stored !== 'dark' && window.matchMedia) {
                var mq = window.matchMedia('(prefers-color-scheme: dark)');
                var self = this;
                var onChange = function (e) { if (!self._manual) self.set(e.matches ? 'dark' : 'light', false); };
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

        // Menu entries are <a href="#"> with an inline onclick and no
        // "return false", so every click also navigated to "#": it scrolled the
        // page to the top and replaced a "#dag=…" share link in the address bar.
        menu.addEventListener('click', function (e) {
            var a = e.target.closest && e.target.closest('a[href="#"]');
            if (a) e.preventDefault();
        });

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
        _epoch: 0,

        // Both a file read and the main-thread fallback can finish after Stop,
        // a different upload, or closing the dialog. Ignore those old callbacks.
        _invalidate: function () {
            this._epoch++;
            if (this._worker) { this._worker.terminate(); this._worker = null; }
            this._resultCode = null;
            document.getElementById('btn-import-dag').disabled = true;
            document.getElementById('btn-download-model').style.display = 'none';
            document.getElementById('btn-cancel-analysis').style.display = 'none';
            document.getElementById('data-modal-preview').style.display = 'none';
        },

        open: function () {
            var modal = document.getElementById('data-discovery-modal');
            if (!modal) return;
            this._invalidate();
            this._csvText = null; this._resultCode = null;
            document.getElementById('data-csv-input').value = '';
            this._setStatus('', '');
            var p = document.getElementById('data-modal-preview');
            if (p) p.style.display = 'none';
            var vs = document.getElementById('data-var-select');
            if (vs) vs.style.display = 'none';
            var dl = document.getElementById('btn-download-model');
            if (dl) dl.style.display = 'none';
            // close() terminates a running analysis but left its Stop button
            // showing the next time the dialog was opened.
            var cancel = document.getElementById('btn-cancel-analysis');
            if (cancel) cancel.style.display = 'none';
            document.getElementById('btn-run-analysis').disabled = true;
            document.getElementById('btn-import-dag').disabled = true;
            modal.style.display = 'flex';
            modal.onclick = function (e) { if (e.target === modal) DataModal.close(); };
            setTimeout(function () {
                var fi = document.getElementById('data-csv-input');
                if (fi && modal.style.display === 'flex') fi.focus();
            }, 50);
        },

        close: function () {
            this._invalidate();
            var modal = document.getElementById('data-discovery-modal');
            if (modal) modal.style.display = 'none';
        },

        /** Called after CSV text is ready — runs parseCSV to show variable selector. */
        _onCsvReady: function (fileName, rowHint) {
            var self = this;
            var parsed;
            try { parsed = CausalDiscovery.parseCSV(this._csvText, null, true); }
            catch (e) {
                this._setStatus('Could not use ' + fileName + ': ' + e.message, 'error');
                document.getElementById('btn-run-analysis').disabled = true;
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
            this._invalidate();
            this._csvText = null; this._resultCode = null;
            document.getElementById('btn-run-analysis').disabled = true;
            document.getElementById('btn-import-dag').disabled = true;
            var vs = document.getElementById('data-var-select');
            if (vs) vs.style.display = 'none';
            var dl = document.getElementById('btn-download-model');
            if (dl) dl.style.display = 'none';

            var self = this, epoch = this._epoch;
            TabularFile.read(file, function (err, res) {
                if (epoch !== self._epoch) return;
                if (err) { self._setStatus(err.message, 'error'); return; }
                self._csvText = res.text;
                self._onCsvReady(res.label, res.rows);
            }, function (status) { if (epoch === self._epoch) self._setStatus(status, 'running'); });
        },

        _worker: null,

        _handleResult: function (result) {
            this._resultCode = result.modelCode;
            this._setProgress(100, 'Analysis complete.');

            var msg = 'Found ' + result.edgeCount + ' edge(s) among ' +
                result.nodeCount + ' variables (' + result.n + ' observations).';
            if (result.undirectedCount > 0)
                msg += ' ' + result.undirectedCount + ' connection(s) shown as — (direction unresolved; review before causal interpretation).';

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
        _runOnMainThread: function (csvText, alpha, useLingam, opts, epoch) {
            var self = this;
            CausalDiscovery.discoverFromCSVAsync(
                csvText, alpha, useLingam,
                function (pct, label) { if (epoch === self._epoch) self._setProgress(pct, label); },
                opts
            ).then(function (result) {
                if (epoch === self._epoch) self._handleResult(result);
            }).catch(function (err) {
                if (epoch === self._epoch) self._handleError(err.message);
            });
        },

        runAnalysis: function () {
            if (!this._csvText) return;
            this._invalidate();
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

            var self = this, epoch = this._epoch;

            document.getElementById('btn-run-analysis').disabled = true;
            document.getElementById('btn-import-dag').disabled   = true;
            document.getElementById('btn-download-model').style.display = 'none';
            this._setProgress(0, 'Starting\u2026');
            document.getElementById('btn-cancel-analysis').style.display = '';

            // Prefer Web Worker (keeps UI fully responsive); fall back to main thread
            if (typeof Worker !== 'undefined') {
                if (this._worker) this._worker.terminate();
                try {
                    // Same URL (including the ?v= cache-buster) as the <script>
                    // tag, so the worker can never run a stale cached copy of
                    // the algorithm alongside a fresh main-thread copy.
                    var tag = document.querySelector('script[src*="causal-discovery.js"]');
                    this._worker = new Worker(tag ? tag.getAttribute('src') : 'js/causal-discovery.js');
                } catch (e) {
                    this._worker = null;
                    this._runOnMainThread(this._csvText, alpha, useLingam, opts, epoch);
                    return;
                }
                var w = this._worker;
                w.onmessage = function (e) {
                    if (epoch !== self._epoch) return;
                    var msg = e.data;
                    if (msg.type === 'progress') self._setProgress(msg.pct, msg.label);
                    else if (msg.type === 'done')  { w.terminate(); self._worker = null; self._handleResult(msg.result); }
                    else if (msg.type === 'error') { w.terminate(); self._worker = null; self._handleError(msg.message); }
                };
                w.onerror = function () {
                    if (epoch !== self._epoch) return;
                    // Worker failed (CORS, CSP, etc.) — fall back to main thread
                    w.terminate(); self._worker = null;
                    self._runOnMainThread(self._csvText, alpha, useLingam, opts, epoch);
                };
                w.postMessage({
                    type:      'analyze',
                    csvText:   this._csvText,
                    alpha:     alpha,
                    useLingam: useLingam,
                    opts:      opts
                });
            } else {
                this._runOnMainThread(this._csvText, alpha, useLingam, opts, epoch);
            }
        },

        cancelAnalysis: function () {
            this._invalidate();
            this._setStatus('Analysis cancelled.', 'warning');
            document.getElementById('btn-run-analysis').disabled = false;
            document.getElementById('btn-cancel-analysis').style.display = 'none';
        },

        importDAG: function () {
            if (!this._resultCode) return;
            var ta = document.getElementById('adj_matrix');
            if (ta && ta.classList.contains('dirty')) {
                this._setStatus('Your model code has unapplied changes. Apply or save that code before importing this graph.', 'warning');
                return;
            }
            try { _loadCodeIntoCanvas(this._resultCode); }
            catch (e) {
                this._setStatus('Could not import this graph. Check that column names are supported by DAGitty; download the suggested code to review it.', 'error');
                return;
            }
            this.close();
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
            var varIdx = Object.create(null);
            if (result.vars) {
                result.vars.forEach(function (v, i) { varIdx[v] = i; });
            }

            // DirectLiNGAM's estimated causal order is the single most useful
            // thing to sanity-check against domain knowledge, so show it first.
            if (result.causalOrder && result.causalOrder.length) {
                var ord = document.createElement('p');
                ord.className = 'modal-preview-order';
                ord.appendChild(document.createTextNode('Estimated causal order: '));
                var strong = document.createElement('strong');
                strong.textContent = result.causalOrder.join(' → ');
                ord.appendChild(strong);
                ord.title = 'DirectLiNGAM ranks the variables from most to least exogenous. ' +
                    'An unexpected order may reflect sampling error, algorithm limitations, or violations of ' +
                    'linearity, non-Gaussian independent errors, or no unmeasured confounding. It is not proof of causal order.';
                content.appendChild(ord);
            }

            var edges;
            try { edges = GraphParser.parseGuess(result.modelCode).getEdges(); }
            catch (e) {
                content.textContent = 'Could not preview this graph. Download the model code to review the variable names and syntax.';
                preview.style.display = 'block';
                return;
            }

            if (!edges.length) {
                var empty = document.createElement('p');
                empty.style.color = 'var(--muted)';
                empty.style.fontSize = '12px';
                empty.textContent = 'No connections retained at these settings. Review the sample size, assumptions and settings before interpreting this result.';
                content.appendChild(empty);
            } else {
                edges.forEach(function (edge) {
                    var d = document.createElement('div');
                    d.className = 'modal-preview-edge';
                    var arrow = edge.directed === Graph.Edgetype.Undirected ? ' — ' :
                        edge.directed === Graph.Edgetype.Bidirected ? ' ↔ ' : ' → ';
                    d.appendChild(document.createTextNode(edge.v1.id + arrow + edge.v2.id));
                    var badge = '';
                    if (result.corrMat && result.vars) {
                        var ai = varIdx[edge.v1.id], bi = varIdx[edge.v2.id];
                        if (ai !== undefined && bi !== undefined) {
                            var r = Math.abs(result.corrMat[ai][bi]);
                            if (isFinite(r)) {
                                var cls = r >= 0.5 ? 'strong' : r >= 0.3 ? 'moderate' : 'weak';
                                badge = '<span class="edge-strength ' + cls + '" title="|r| = ' +
                                    r.toFixed(2) + ' (pairwise correlation, not a causal effect)">|r| = ' + r.toFixed(2) + '</span>';
                            }
                        }
                    }
                    if (badge) d.insertAdjacentHTML('beforeend', badge);
                    content.appendChild(d);
                });
            }
            preview.style.display = 'block';
        }
    };

    // SheetJS is only needed when the user picks an Excel/ODS file, so it is
    // loaded lazily. Served from the vendor's own CDN (SheetJS was removed from
    // npm/cdnjs, which is stuck on the vulnerable 0.18.5) and pinned with a
    // Subresource Integrity hash, so a compromised or swapped CDN file is
    // rejected by the browser rather than executed.
    var SHEETJS_VERSION   = '0.20.3';
    var SHEETJS_URL       = 'https://cdn.sheetjs.com/xlsx-' + SHEETJS_VERSION +
                            '/package/dist/xlsx.full.min.js';
    var SHEETJS_INTEGRITY = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';

    function _loadSheetJS(cb) {
        if (window.XLSX) { cb(true); return; }
        var s = document.createElement('script');
        s.src = SHEETJS_URL;
        s.integrity = SHEETJS_INTEGRITY;
        s.crossOrigin = 'anonymous';
        s.onload = function () { cb(true); };
        s.onerror = function () { cb(false); };
        document.head.appendChild(s);
    }

    /**
     * Read a data file (CSV / TSV / TXT / Excel / ODS) into delimited text.
     * Shared by the discovery dialog and the local-tests tool.
     *
     * @param {File}     file
     * @param {Function} cb(err, {text, label, rows})  label = file or sheet name
     * @param {Function} [onStatus](message)           progress text for the UI
     */
    window.TabularFile = {
        read: function (file, cb, onStatus) {
            if (!file) { cb(new Error('No file chosen.')); return; }
            var ext = (file.name.split('.').pop() || '').toLowerCase();
            var status = onStatus || function () {};

            if (ext === 'pkl' || ext === 'pickle') {
                cb(new Error('Python pickle files cannot be read in the browser. ' +
                    'Export to CSV first: df.to_csv("data.csv", index=False)'));
                return;
            }

            if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsb' || ext === 'ods') {
                status('Loading Excel support…');
                _loadSheetJS(function (ok) {
                    if (!ok) { cb(new Error('Failed to load Excel library. Try saving as CSV instead.')); return; }
                    var reader = new FileReader();
                    reader.onload = function (e) {
                        try {
                            var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
                            var ws = wb.Sheets[wb.SheetNames[0]];
                            var text = XLSX.utils.sheet_to_csv(ws);
                            cb(null, { text: text, label: 'sheet "' + wb.SheetNames[0] + '"',
                                       rows: text.trim().split('\n').length - 1 });
                        } catch (err) {
                            cb(new Error('Error reading Excel: ' + err.message));
                        }
                    };
                    reader.onerror = function () { cb(new Error('Could not read file.')); };
                    reader.readAsArrayBuffer(file);
                });
                return;
            }

            status('Reading file…');
            var reader = new FileReader();
            reader.onload = function (e) {
                var text = String(e.target.result);
                cb(null, { text: text, label: file.name, rows: text.trim().split(/\r?\n/).length - 1 });
            };
            reader.onerror = function () { cb(new Error('Could not read file.')); };
            reader.readAsText(file);
        }
    };

    // ── 8b. Tooltips ──────────────────────────────────────────────────────────
    // The "?" help badges previously relied on the native `title` tooltip, which
    // is slow, unstyled, and unreliable across browsers. Replace it with a small
    // styled popover shown on hover and keyboard focus.

    function initTooltips() {
        var tip = null, owner = null, hideTimer = null;
        function keep() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
        function hideSoon() { keep(); hideTimer = setTimeout(hide, 150); }
        function ensure() {
            if (!tip) {
                tip = document.createElement('div');
                tip.className = 'app-tooltip';
                tip.id = 'dagitty-help-tooltip';
                tip.setAttribute('role', 'tooltip');
                tip.addEventListener('mouseenter', keep);
                tip.addEventListener('mouseleave', function () {
                    if (document.activeElement !== owner) hide();
                });
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
                el.setAttribute('role', 'button');
                return t;
            }
            return '';
        }
        function show(el) {
            keep();
            var txt = textFor(el);
            if (!txt) return;
            if (owner && owner !== el) hide();
            owner = el;
            var t = ensure();
            var ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
            if (ids.indexOf(t.id) < 0) ids.push(t.id);
            el.setAttribute('aria-describedby', ids.join(' '));
            t.textContent = txt;
            t.style.display = 'block';
            t.style.left = '0'; t.style.top = '0';
            var r = el.getBoundingClientRect(), tw = t.offsetWidth, th = t.offsetHeight, gap = 8;
            var left = r.left + r.width / 2 - tw / 2;
            var top = r.bottom + gap;
            if (top + th > window.innerHeight - 4) top = r.top - gap - th;
            left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
            t.style.left = left + 'px'; t.style.top = Math.max(6, top) + 'px';
            t.classList.add('on');
        }
        function hide() {
            keep();
            if (owner && tip) {
                var ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) { return id && id !== tip.id; });
                if (ids.length) owner.setAttribute('aria-describedby', ids.join(' '));
                else owner.removeAttribute('aria-describedby');
            }
            owner = null;
            if (tip) { tip.classList.remove('on'); tip.style.display = 'none'; }
        }

        var sel = '.help-tip';
        // Several badges sit inside a collapsible <h3>, whose inline onclick
        // toggles the section. Clicking "?" for help must not fold the panel
        // away; intercept in the capture phase, before the header's handler
        // runs. On touch devices, where there is no hover, the tap shows the tip.
        document.addEventListener('click', function (e) {
            var el = e.target.closest && e.target.closest(sel);
            if (el) { e.stopPropagation(); e.preventDefault(); show(el); }
            else if (!tip || !tip.contains(e.target)) hide();
        }, true);
        document.addEventListener('mouseover', function (e) { var el = e.target.closest && e.target.closest(sel); if (el) show(el); });
        document.addEventListener('mouseout', function (e) {
            var el = e.target.closest && e.target.closest(sel);
            if (el && document.activeElement !== el && (!tip || !tip.contains(e.relatedTarget))) hideSoon();
        });
        document.addEventListener('focusin',   function (e) { var el = e.target.closest && e.target.closest(sel); if (el) show(el); });
        document.addEventListener('focusout',  function (e) { var el = e.target.closest && e.target.closest(sel); if (el) hide(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && owner) { e.preventDefault(); e.stopImmediatePropagation(); hide(); return; }
            var el = e.target.closest && e.target.closest(sel);
            if (el && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault(); e.stopImmediatePropagation(); show(el);
            }
        }, true);
        window.addEventListener('resize', hide);
        document.addEventListener('scroll', function (e) {
            if (!tip || !tip.contains(e.target)) hide();
        }, true);

        // Pre-convert existing badges so the native tooltip never appears and
        // they're keyboard-focusable.
        document.querySelectorAll('.help-tip[title]').forEach(textFor);
        new window.MutationObserver(function () {
            document.querySelectorAll('.help-tip[title]').forEach(textFor);
        }).observe(document.body, { childList: true, subtree: true });
    }

    // Keep keyboard focus inside each modal, including dialogs created later by
    // the wizard, tests and list editor. Closing returns to the opening control.
    function initModalKeyboard() {
        var active = null, opener = null, fallback = null, lastOutside = document.activeElement;
        function visible(el) { return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); }
        function current() {
            return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).filter(visible).pop() || null;
        }
        function items(modal) {
            return Array.from(modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')).filter(function (el) {
                return !el.disabled && el.tabIndex >= 0 && visible(el);
            });
        }
        function focusFirst(modal) {
            var first = items(modal)[0];
            if (first) first.focus();
            else { modal.tabIndex = -1; modal.focus(); }
        }
        function sync() {
            var next = current();
            if (next === active) return;
            var old = active;
            active = next;
            if (next) {
                if (!old) {
                    opener = next.contains(document.activeElement) ? lastOutside : document.activeElement;
                    var menu = opener && opener.closest && opener.closest('#menu > li');
                    fallback = menu ? menu.querySelector('a[aria-haspopup="true"]') : null;
                }
                if (!next.contains(document.activeElement)) focusFirst(next);
            } else {
                var target = opener && opener.isConnected && visible(opener) ? opener : fallback;
                if (target && target.isConnected && visible(target)) target.focus();
                opener = null; fallback = null;
            }
        }
        new window.MutationObserver(sync).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
        document.addEventListener('focusin', function (e) {
            var modal = current();
            if (modal && !modal.contains(e.target)) focusFirst(modal);
            else if (!modal) lastOutside = e.target;
        });
        document.addEventListener('keydown', function (e) {
            var modal = current();
            if (!modal || e.key !== 'Tab') return;
            var all = items(modal), first = all[0], last = all[all.length - 1];
            if (!first) { e.preventDefault(); focusFirst(modal); }
            else if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
                e.preventDefault(); first.focus();
            }
            e.stopPropagation();
        }, true);
        document.addEventListener('keydown', function (e) {
            var modal = current();
            if (!modal || e.defaultPrevented || e.key !== 'Escape') return;
            var close = modal.querySelector('.modal-close, #tour-x');
            if (close) { e.preventDefault(); close.click(); }
        });
    }

    // ── 8c. Export model as R code (dagitty / ggdag) ──────────────────────────

    window.RCodeExport = { generate: function (graph) {
        var code = graph ? graph.toString() : 'dag { }';
        // The model goes inside a single-quoted R string: a variable name such
        // as "Parent's income" would otherwise terminate it early.
        var rstr = code.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        return (
            '# DAG exported from DAGitty — reproduce and analyse in R\n' +
            'library(dagitty)\n\n' +
            'g <- dagitty(\'' + rstr + '\')\n\n' +
            'plot(g)\n\n' +
            '# Tidyverse-friendly plotting & analysis with ggdag:\n' +
            '# library(ggdag)\n' +
            '# ggdag(g) + theme_dag()\n' +
            '# ggdag_adjustment_set(g)            # minimal sufficient adjustment set(s)\n' +
            '# impliedConditionalIndependencies(g)\n' +
            '# localTests(g, data = your_data)    # data columns must match variable names\n' +
            '# Failure to reject a test does not validate the diagram or its causal directions.\n');
    } };

    window.exportRCode = function () {
        var r = window.RCodeExport.generate(window.Model && Model.dag);
        if (window.DAGittyControl && DAGittyControl.getView) {
            DAGittyControl.getView().openHTMLDialog(
                '<p style="margin:.2em 0 .5em;font-size:12px">R code (uses the <code>dagitty</code> package; ' +
                'works directly with <code>ggdag</code>). Copy it into your script:</p>' +
                '<textarea style="width:92%" rows="12" readonly onclick="this.select()">' +
                _escHtml(r) + '</textarea>', 'OK');
        }
    };

    // ── 9. Undo/Redo keyboard handler ─────────────────────────────────────────

    // Ctrl+Z inside a text field means "undo my typing". Intercepting it there
    // rewound the whole diagram instead — while renaming a variable, editing the
    // model code, or filling in the wizard — and blocked the field's own undo.
    function _inTextField(e) {
        var t = e.target;
        if (!t || !t.tagName) return false;
        var tag = t.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
    }

    function initUndoRedoKeys() {
        // Wrap document.onkeydown that initialize() set
        var _orig = document.onkeydown;
        document.onkeydown = function (e) {
            var mod = (e.ctrlKey || e.metaKey) && !_inTextField(e);
            var key = (e.key || '').toLowerCase();
            if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); UndoRedo.undo(); return; }
            if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); UndoRedo.redo(); return; }
            if (_orig) _orig.call(document, e);
        };
    }

    // The full-width toolbar can wrap on small screens. Its measured height
    // keeps the canvas, sidebars and help overlays aligned at every breakpoint.
    function initResponsiveLayout() {
        var menu = document.getElementById('menu');
        if (!menu) return;
        function sync() {
            var height = Math.ceil(menu.getBoundingClientRect().height);
            if (!height || document.documentElement.style.getPropertyValue('--menu-h') === height + 'px') return;
            document.documentElement.style.setProperty('--menu-h', height + 'px');
            if (window.DAGittyControl && DAGittyControl.getView) {
                var view = DAGittyControl.getView();
                if (view && view.resize) view.resize();
            }
        }
        if (window.ResizeObserver) new window.ResizeObserver(sync).observe(menu);
        window.addEventListener('resize', sync);
        sync();
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
            // Dragging a variable or bending an arrow only fires the layout
            // event, so those moves were not undoable. It fires once per drag
            // end; debounce anyway so a flurry of nudges is one undo step.
            var layoutPush = null;
            DAGittyControl.observe('graphlayoutchange', function () {
                if (layoutPush) clearTimeout(layoutPush);
                layoutPush = setTimeout(function () { layoutPush = null; UndoRedo.push(); }, 400);
            });
        }

        initUndoRedoKeys();
        initMenuKeyboard();
        initSectionHeaders();
        initTooltips();
        initModalKeyboard();
        BeginnerMode.init();
        ThemeToggle.init();
        initResponsiveLayout();

        var discovery = document.getElementById('data-discovery-modal');
        if (discovery) discovery.addEventListener('change', function (e) {
            if (e.target.id === 'data-csv-input' || !DataModal._csvText) return;
            DataModal._invalidate();
            document.getElementById('btn-run-analysis').disabled = false;
            DataModal._setStatus('Settings changed. Run the analysis again to update the suggestion.', 'warning');
        });

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
