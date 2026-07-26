/* DAGitty — Workspace: opening, keeping and sharing a model
 *
 * Three gaps that hurt beginners most, none of which the editor covered:
 *
 *   1. You could download a model but not open one again. The only way back in
 *      was to paste the code into the Model-code box, which people do not find.
 *   2. A reload lost everything. No autosave, no recovery.
 *   3. Sharing a diagram required publishing it to dagitty.net. There was no way
 *      to send a collaborator "here is exactly my model" as a link.
 *
 * This module adds Open / Autosave+restore / Copy-shareable-link, plus
 * drag-and-drop of a model or data file anywhere on the page.
 */

(function () {
    'use strict';

    var AUTOSAVE_KEY = 'dagitty_autosave';
    var AUTOSAVE_MS  = 600;
    var MAX_LINK     = 8000;   // conservative practical URL limit

    // ── Loading a model ───────────────────────────────────────────────────

    /**
     * Does this text plausibly contain a model?
     *
     * GraphParser.parseGuess falls back to its adjacency-list format for any
     * input it does not recognise, which turns an arbitrary text file into a
     * diagram made of nonsense variables. That is acceptable when someone types
     * into the model-code box; it is not acceptable when a stray file is opened
     * or dropped and silently replaces their work. So require the text to
     * actually look like a model first: a `dag { … }`-style header, an arrow, or
     * a plain 0/1 adjacency matrix.
     */
    function looksLikeModel(text) {
        var t = String(text).trim();
        if (!t) return false;
        if (/^(digraph|graph|dag|pdag|mag|pag)(\s+\w+)?\s*\{[\s\S]*\}$/mi.test(t)) return true;
        if (/(->|<->|<-)/m.test(t)) return true;
        if (/^[\s01]+$/.test(t)) return true;
        return false;
    }

    /** Parse + install model code, reporting a readable error if it is invalid. */
    function loadCode(code, sourceLabel) {
        var g;
        if (!looksLikeModel(code)) {
            toast((sourceLabel || 'That file') + ' does not look like a DAGitty model. ' +
                  'Model files contain a block like “dag { … }”, or arrows such as “A -> B”.', 'error');
            return false;
        }
        try {
            g = GraphParser.parseGuess(code);
        } catch (e) {
            toast('Could not read ' + (sourceLabel || 'that model') +
                  ' — it does not look like DAGitty model code.', 'error');
            return false;
        }
        if (!g || g.getNumberOfVertices() === 0) {
            toast((sourceLabel || 'That model') + ' contains no variables.', 'error');
            return false;
        }
        var ta = document.getElementById('adj_matrix');
        if (ta) { ta.value = code; ta.style.backgroundColor = ''; }
        displayHide('model_refresh');
        if (!g.hasCompleteLayout()) new GraphLayouter.Spring(g).layout();
        DAGittyControl.setGraph(g);
        return true;
    }

    function readModelFile(file) {
        var reader = new FileReader();
        reader.onload = function (e) {
            if (loadCode(String(e.target.result), '“' + file.name + '”'))
                toast('Opened ' + file.name, 'ok');
        };
        reader.onerror = function () { toast('Could not read ' + file.name + '.', 'error'); };
        reader.readAsText(file);
    }

    var _fileInput = null;
    function openFile() {
        if (!_fileInput) {
            _fileInput = document.createElement('input');
            _fileInput.type = 'file';
            _fileInput.accept = '.dag,.dagitty,.txt,.dot,.gv,text/plain';
            _fileInput.style.display = 'none';
            _fileInput.addEventListener('change', function () {
                if (this.files && this.files[0]) readModelFile(this.files[0]);
                this.value = '';       // allow re-opening the same file
            });
            document.body.appendChild(_fileInput);
        }
        _fileInput.click();
    }

    // ── Shareable link ────────────────────────────────────────────────────
    // The whole model travels in the URL fragment, so nothing is uploaded
    // anywhere and the link keeps working offline and forever.

    function encodeModel(code) {
        var b64 = btoa(unescape(encodeURIComponent(code)));
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function decodeModel(s) {
        var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return decodeURIComponent(escape(atob(b64)));
    }

    function shareLink() {
        var code = (window.Model && Model.dag) ? Model.dag.toString() : '';
        if (!code) { toast('Nothing to share yet.', 'error'); return; }
        var url = location.origin + location.pathname + '#dag=' + encodeModel(code);
        if (url.length > MAX_LINK) {
            toast('This diagram is too large for a link (' + url.length + ' characters). ' +
                  'Use Model → Download instead.', 'error');
            return;
        }
        var done = function (ok) {
            toast(ok ? 'Link copied — it contains the whole diagram, so anyone who opens it ' +
                       'sees exactly this model.'
                     : 'Could not copy automatically. The link is in the address bar.', ok ? 'ok' : 'error');
        };
        // Reflect it in the address bar either way, so a failed copy is recoverable.
        _lastHash = '#dag=' + encodeModel(code);
        try { history.replaceState(null, '', url); } catch (e) {}
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
        } else {
            done(false);
        }
    }

    // ── Autosave ──────────────────────────────────────────────────────────

    var _saveTimer = null;

    // Whatever the page started with — the built-in example, a restored session,
    // or a shared link. Autosaving that would mean greeting every visitor with
    // "restored your work" even if they never touched anything, so only real
    // edits are saved.
    var _baseline = null;

    function resetBaseline() {
        _baseline = (window.Model && Model.dag) ? Model.dag.toString() : null;
    }

    function autosave() {
        if (!window.Model || !Model.dag) return;
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function () {
            _saveTimer = null;
            var code = Model.dag.toString();
            if (code === _baseline) return;
            try {
                localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ code: code, ts: Date.now() }));
            } catch (e) { /* private mode / quota — autosave is best-effort */ }
        }, AUTOSAVE_MS);
    }

    function readAutosave() {
        try {
            var raw = localStorage.getItem(AUTOSAVE_KEY);
            if (!raw) return null;
            var o = JSON.parse(raw);
            return (o && typeof o.code === 'string' && o.code.trim()) ? o : null;
        } catch (e) { return null; }
    }

    function clearAutosave() {
        try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {}
    }

    function ago(ts) {
        var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 90) return 'a moment ago';
        var m = Math.round(s / 60);
        if (m < 90) return m + ' minute' + (m !== 1 ? 's' : '') + ' ago';
        var h = Math.round(m / 60);
        if (h < 36) return h + ' hour' + (h !== 1 ? 's' : '') + ' ago';
        return Math.round(h / 24) + ' day(s) ago';
    }

    var _lastHash = null;

    /** Load the model in #dag=… if there is one. Returns true if it handled it. */
    function loadFromHash() {
        var m = /#dag=([A-Za-z0-9\-_]+)/.exec(location.hash);
        if (!m) return false;
        _lastHash = location.hash;
        var code;
        try { code = decodeModel(m[1]); }
        catch (e) { toast('That shared link is damaged and could not be opened.', 'error'); return true; }
        var ok = loadCode(code, 'the shared link');
        if (ok) { resetBaseline(); toast('Opened the diagram from the shared link.', 'ok'); }
        return true;
    }

    /** Restore the previous session unless the URL already asks for a model. */
    function maybeRestore() {
        if (/[?&]id=/.test(location.search)) return;      // ?id= is handled by initialize()

        if (loadFromHash()) return;

        var saved = readAutosave();
        if (!saved) return;
        if (loadCode(saved.code, 'your saved work')) {
            resetBaseline();
            toast('Restored the diagram you were working on (' + ago(saved.ts) + ').', 'ok', [{
                label: 'Start fresh',
                action: function () {
                    clearAutosave();
                    if (window.newModel) newModel();
                    resetBaseline();
                }
            }]);
        }
    }

    // ── Drag and drop ─────────────────────────────────────────────────────

    function initDragDrop() {
        var overlay = null, depth = 0;

        function showOverlay() {
            if (overlay) return;
            overlay = document.createElement('div');
            overlay.id = 'drop-overlay';
            overlay.innerHTML = '<div class="drop-overlay-inner">' +
                '<p class="drop-title">Drop to open</p>' +
                '<p class="drop-sub">A model file (.dag, .txt) opens on the canvas.<br>' +
                'A data file (.csv, .tsv, .xlsx) opens the discovery tool.</p></div>';
            document.body.appendChild(overlay);
        }
        function hideOverlay() {
            depth = 0;
            if (overlay) { overlay.remove(); overlay = null; }
        }

        window.addEventListener('dragenter', function (e) {
            if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
            e.preventDefault(); depth++; showOverlay();
        });
        window.addEventListener('dragover', function (e) {
            if (overlay) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
        });
        window.addEventListener('dragleave', function () {
            if (overlay && --depth <= 0) hideOverlay();
        });
        window.addEventListener('drop', function (e) {
            if (!overlay) return;
            e.preventDefault();
            hideOverlay();
            var file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            var ext = (file.name.split('.').pop() || '').toLowerCase();
            if (['csv', 'tsv', 'xlsx', 'xls', 'xlsb', 'ods'].indexOf(ext) !== -1) {
                if (window.DataModal) { DataModal.open(); DataModal.handleFile(file); }
            } else {
                readModelFile(file);
            }
        });
    }

    // ── Toast ─────────────────────────────────────────────────────────────

    var _toastTimer = null;
    function toast(message, level, actions) {
        var host = document.getElementById('app-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'app-toast';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        host.replaceChildren();
        host.className = 'toast-' + (level || 'ok');

        var text = document.createElement('span');
        text.className = 'toast-text';
        text.textContent = message;
        host.appendChild(text);

        (actions || []).forEach(function (a) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'toast-action';
            b.textContent = a.label;
            b.addEventListener('click', function () { hideToast(); a.action(); });
            host.appendChild(b);
        });

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '✕';
        close.addEventListener('click', hideToast);
        host.appendChild(close);

        host.classList.add('on');
        if (_toastTimer) clearTimeout(_toastTimer);
        // Leave actionable messages up long enough to actually act on them.
        _toastTimer = setTimeout(hideToast, (actions && actions.length) ? 14000 : 6000);
    }

    function hideToast() {
        var host = document.getElementById('app-toast');
        if (host) host.classList.remove('on');
        if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    }

    // ── Wiring ────────────────────────────────────────────────────────────

    window.Workspace = {
        openFile:  openFile,
        shareLink: shareLink,
        toast:     toast,
        clearAutosave: clearAutosave
    };

    window.addEventListener('load', function () {
        initDragDrop();
        if (_baseline === null) resetBaseline();   // the built-in example, unless…
        maybeRestore();                            // …a link or saved session replaces it
        if (window.DAGittyControl) DAGittyControl.observe('graphchange', autosave);

        // Pasting a share link into a tab that already has DAGitty open only
        // changes the fragment — the browser does not reload, so nothing would
        // happen without this. Ignore the fragment we wrote ourselves in
        // shareLink(), which must not clobber the model it was made from.
        window.addEventListener('hashchange', function () {
            if (location.hash === _lastHash) return;
            loadFromHash();
        });
    });

})();
