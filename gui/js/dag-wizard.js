/* DAGitty — Guided DAG builder ("wizard")
 *
 * A staged, step-by-step flow for building a first causal diagram, aimed at
 * people new to causal inference. Instead of dropping users straight onto a
 * blank canvas, it walks them through the modelling decisions — exposure,
 * outcome, other variables (and whether each is measured), and an optional
 * selection node — then auto-draws the arrows implied by the roles and drops
 * them into the full interface to refine.
 *
 * Arrows are NOT hand-entered in the wizard (that was more friction than it was
 * worth): they are derived from the declared roles and then edited on the canvas.
 *
 * Augments the GUI without touching main.js. Builds standard DAGitty model code
 * and hands it to loadDAGFromTextData() + the spring layouter.
 */

(function () {
    'use strict';

    var state = null;
    var root = null;

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function clean(name) { return String(name || '').replace(/["{}]/g, '').trim(); }

    // ── Steps ───────────────────────────────────────────────────────────────────

    var STEPS = [
        {
            title: 'Build a causal diagram, step by step',
            render: function () {
                return '' +
                  '<p class="wiz-lead">A <strong>causal diagram</strong> (a DAG) is a picture of what you believe ' +
                  'causes what. We\'ll build one together in a few short steps — you can edit everything afterwards.</p>' +
                  '<fieldset class="wiz-fieldset"><legend>How much do you want to see?</legend>' +
                    '<label class="wiz-radio"><input type="radio" name="wiz-mode" value="beginner" checked> ' +
                      '<span><strong>Beginner</strong> — a simplified interface with just the essentials. ' +
                      '<span class="wiz-muted">Recommended if you\'re new to causal inference.</span></span></label>' +
                    '<label class="wiz-radio"><input type="radio" name="wiz-mode" value="advanced"> ' +
                      '<span><strong>Advanced</strong> — every panel and option available.</span></label>' +
                  '</fieldset>';
            },
            onLeave: function () {
                var r = root.querySelector('input[name="wiz-mode"]:checked');
                state.mode = r ? r.value : 'beginner';
            }
        },
        {
            title: 'What is the cause you\'re studying?',
            render: function () {
                return '' +
                  '<p class="wiz-lead">The <span class="wiz-term">exposure</span> is the cause whose effect you want ' +
                  'to estimate — the "treatment", intervention, or risk factor.</p>' +
                  '<p class="wiz-eg">e.g. <em>a drug, a policy, hours of screen time, a genotype.</em></p>' +
                  '<label class="wiz-input-label">Exposure variable name' +
                    '<input type="text" id="wiz-exposure" class="wiz-input" placeholder="e.g. Treatment" ' +
                    'value="' + esc(state.exposure) + '" autocomplete="off"></label>';
            },
            focus: 'wiz-exposure',
            valid: function () { return clean(root.querySelector('#wiz-exposure').value).length > 0; },
            onLeave: function () { state.exposure = clean(root.querySelector('#wiz-exposure').value); }
        },
        {
            title: 'What is the effect you want to explain?',
            render: function () {
                return '' +
                  '<p class="wiz-lead">The <span class="wiz-term">outcome</span> is the effect you\'re trying to ' +
                  'understand — what the exposure might change.</p>' +
                  '<p class="wiz-eg">e.g. <em>recovery, test score, disease status, churn.</em></p>' +
                  '<label class="wiz-input-label">Outcome variable name' +
                    '<input type="text" id="wiz-outcome" class="wiz-input" placeholder="e.g. Recovery" ' +
                    'value="' + esc(state.outcome) + '" autocomplete="off"></label>';
            },
            focus: 'wiz-outcome',
            valid: function () {
                var o = clean(root.querySelector('#wiz-outcome').value);
                return o.length > 0 && o !== state.exposure;
            },
            invalidMsg: function () {
                var o = clean(root.querySelector('#wiz-outcome').value);
                if (!o.length) return 'Enter an outcome name.';
                if (o === state.exposure) return 'The outcome must be different from the exposure.';
                return '';
            },
            onLeave: function () { state.outcome = clean(root.querySelector('#wiz-outcome').value); }
        },
        {
            title: 'Add any other relevant variables',
            render: function () {
                return '' +
                  '<p class="wiz-lead">Add other variables that matter for the ' +
                  '<strong>' + esc(state.exposure || 'exposure') + ' → ' + esc(state.outcome || 'outcome') + '</strong> ' +
                  'relationship. Pick a role — we\'ll draw the usual arrows automatically, and you can fine-tune them ' +
                  'on the canvas afterwards. Mark whether each is <strong>measured</strong>: unmeasured variables ' +
                  'become unobserved (latent) and can\'t be adjusted for. This step is optional.</p>' +
                  '<dl class="wiz-defs">' +
                    '<div><dt>Confounder</dt><dd>a common cause of both the exposure and the outcome ' +
                      '(creates a spurious association — usually must be adjusted for).</dd></div>' +
                    '<div><dt>Mediator</dt><dd>sits on the causal pathway: exposure → mediator → outcome ' +
                      '(part of how the effect happens).</dd></div>' +
                    '<div><dt>Collider</dt><dd>a common effect of two variables ' +
                      '(adjusting for it can <em>create</em> bias).</dd></div>' +
                    '<div><dt>Other</dt><dd>e.g. another cause of the outcome; no arrows added automatically.</dd></div>' +
                  '</dl>' +
                  '<div class="wiz-add-row">' +
                    '<input type="text" id="wiz-var-name" class="wiz-input" placeholder="Variable name" autocomplete="off">' +
                    '<select id="wiz-var-role" class="wiz-input">' +
                      '<option value="confounder">Confounder</option>' +
                      '<option value="mediator">Mediator</option>' +
                      '<option value="collider">Collider</option>' +
                      '<option value="other">Other</option>' +
                    '</select>' +
                    '<label class="wiz-check wiz-measured"><input type="checkbox" id="wiz-var-measured" checked> measured</label>' +
                    '<button type="button" class="wiz-add-btn" id="wiz-add-var">Add</button>' +
                  '</div>' +
                  '<ul class="wiz-chiplist" id="wiz-var-list"></ul>';
            },
            focus: 'wiz-var-name',
            mount: function () {
                var add = function () {
                    var nameEl = root.querySelector('#wiz-var-name');
                    var name = clean(nameEl.value);
                    var role = root.querySelector('#wiz-var-role').value;
                    var measured = root.querySelector('#wiz-var-measured').checked;
                    if (!name) return;
                    var taken = name === state.exposure || name === state.outcome ||
                        state.others.some(function (o) { return o.name === name; });
                    if (taken) { flash(nameEl); return; }
                    state.others.push({ name: name, role: role, measured: measured });
                    nameEl.value = ''; nameEl.focus();
                    root.querySelector('#wiz-var-measured').checked = true;
                    renderVarList();
                };
                root.querySelector('#wiz-add-var').addEventListener('click', add);
                root.querySelector('#wiz-var-name').addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); add(); }
                });
                renderVarList();
            }
        },
        {
            title: 'Did selection into the sample play a role?',
            render: function () {
                return '' +
                  '<p class="wiz-lead">Optional but valuable. A <span class="wiz-term">selection node</span> represents ' +
                  'whether someone ended up in your sample (e.g. "agreed to join the study", "wasn\'t lost to ' +
                  'follow-up"). Because everyone in your data <em>is</em> selected, the analysis conditions on it — so ' +
                  'if the exposure or outcome affects selection, you get a <strong>collider (selection) bias</strong> ' +
                  'that\'s easy to overlook.</p>' +
                  '<label class="wiz-check"><input type="checkbox" id="wiz-sel-enabled"> Add a selection node</label>' +
                  '<div id="wiz-sel-detail" style="display:none;margin-top:.9em">' +
                    '<label class="wiz-input-label">Name of the selection variable' +
                      '<input type="text" id="wiz-sel-name" class="wiz-input" value="' + esc(state.selection.name) + '" autocomplete="off"></label>' +
                    '<p class="wiz-sub">Which variables affect who ends up in the sample? Each adds an arrow ' +
                      '<em>into</em> the selection node.</p>' +
                    '<div id="wiz-sel-causes" class="wiz-check-grid"></div>' +
                    '<p class="wiz-eg" id="wiz-sel-warn" style="display:none">⚠ Both the exposure and outcome affect ' +
                      'selection — that\'s the classic selection-bias collider.</p>' +
                  '</div>';
            },
            mount: function () {
                var enabledEl = root.querySelector('#wiz-sel-enabled');
                var detail = root.querySelector('#wiz-sel-detail');
                enabledEl.checked = state.selection.enabled;
                detail.style.display = state.selection.enabled ? 'block' : 'none';
                enabledEl.addEventListener('change', function () {
                    detail.style.display = enabledEl.checked ? 'block' : 'none';
                });
                var grid = root.querySelector('#wiz-sel-causes');
                grid.innerHTML = '';
                var warn = function () {
                    var w = root.querySelector('#wiz-sel-warn');
                    var exp = grid.querySelector('input[data-cause="' + cssEsc(state.exposure) + '"]');
                    var out = grid.querySelector('input[data-cause="' + cssEsc(state.outcome) + '"]');
                    if (w) w.style.display = (exp && exp.checked && out && out.checked) ? 'block' : 'none';
                };
                allVarNames().forEach(function (n) {
                    var lbl = document.createElement('label');
                    lbl.className = 'wiz-check';
                    var cb = document.createElement('input');
                    cb.type = 'checkbox'; cb.checked = !!state.selection.causes[n];
                    cb.setAttribute('data-cause', n);
                    cb.addEventListener('change', warn);
                    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + n));
                    grid.appendChild(lbl);
                });
                warn();
            },
            onLeave: function () {
                var enabledEl = root.querySelector('#wiz-sel-enabled');
                state.selection.enabled = !!(enabledEl && enabledEl.checked);
                var nameEl = root.querySelector('#wiz-sel-name');
                if (nameEl) state.selection.name = clean(nameEl.value) || 'Selected';
                state.selection.causes = {};
                root.querySelectorAll('#wiz-sel-causes input[type="checkbox"]').forEach(function (cb) {
                    state.selection.causes[cb.getAttribute('data-cause')] = cb.checked;
                });
            }
        },
        {
            title: 'Ready to build',
            render: function () {
                var n = 2 + state.others.length + (state.selection.enabled ? 1 : 0);
                var nEdges = autoEdges().length;
                var unmeasured = state.others.filter(function (o) { return !o.measured; }).map(function (o) { return o.name; });
                return '' +
                  '<p class="wiz-lead">Your diagram has <strong>' + n + '</strong> variable' + (n !== 1 ? 's' : '') +
                  ' and <strong>' + nEdges + '</strong> arrow' + (nEdges !== 1 ? 's' : '') +
                  ' (added automatically from the roles you chose). We\'ll draw it, arrange it, and open it in the ' +
                  'editor — where you can add or change arrows, and DAGitty will tell you what to adjust for.</p>' +
                  '<div class="wiz-summary">' +
                    '<p><span class="wiz-pill wiz-pill-exp">exposure</span> ' + esc(state.exposure || '—') + '</p>' +
                    '<p><span class="wiz-pill wiz-pill-out">outcome</span> ' + esc(state.outcome || '—') + '</p>' +
                    (state.others.length ? '<p><span class="wiz-pill">others</span> ' +
                        esc(state.others.map(function (o) { return o.name; }).join(', ')) + '</p>' : '') +
                    (unmeasured.length ? '<p><span class="wiz-pill">unobserved</span> ' + esc(unmeasured.join(', ')) + '</p>' : '') +
                    (state.selection.enabled ? '<p><span class="wiz-pill">selection</span> ' + esc(state.selection.name) + '</p>' : '') +
                  '</div>' +
                  '<label class="wiz-check"><input type="checkbox" id="wiz-tour" checked> ' +
                    'Give me a quick tour of the interface afterwards</label>';
            }
        }
    ];

    function cssEsc(s) { return String(s).replace(/(["\\\]\[])/g, '\\$1'); }

    // ── Sub-renderers ─────────────────────────────────────────────────────────

    function renderVarList() {
        var ul = root.querySelector('#wiz-var-list');
        if (!ul) return;
        ul.innerHTML = '';
        if (!state.others.length) {
            ul.innerHTML = '<li class="wiz-empty">No other variables yet (optional).</li>';
            return;
        }
        state.others.forEach(function (o, i) {
            var li = document.createElement('li');
            li.className = 'wiz-chip';
            li.innerHTML = '<span>' + esc(o.name) + '</span><span class="wiz-chip-role">' + o.role +
                (o.measured ? '' : ' · unobserved') + '</span><button type="button" aria-label="Remove">✕</button>';
            li.querySelector('button').addEventListener('click', function () {
                var removed = state.others.splice(i, 1)[0];
                if (removed) delete state.selection.causes[removed.name];
                renderVarList();
            });
            ul.appendChild(li);
        });
    }

    function allVarNames() {
        var names = [];
        if (state.exposure) names.push(state.exposure);
        if (state.outcome) names.push(state.outcome);
        state.others.forEach(function (o) { names.push(o.name); });
        return names;
    }

    function flash(el) {
        el.classList.add('wiz-flash');
        setTimeout(function () { el.classList.remove('wiz-flash'); }, 600);
    }

    // ── Arrows implied by the declared roles ────────────────────────────────────

    function autoEdges() {
        var edges = [];
        var add = function (from, to) {
            if (from && to && from !== to &&
                !edges.some(function (e) { return e.from === from && e.to === to; })) edges.push({ from: from, to: to });
        };
        if (state.exposure && state.outcome) add(state.exposure, state.outcome);
        state.others.forEach(function (o) {
            if (o.role === 'confounder') { add(o.name, state.exposure); add(o.name, state.outcome); }
            else if (o.role === 'mediator') { add(state.exposure, o.name); add(o.name, state.outcome); }
            else if (o.role === 'collider') { add(state.exposure, o.name); add(state.outcome, o.name); }
        });
        if (state.selection.enabled && state.selection.name) {
            Object.keys(state.selection.causes).forEach(function (v) {
                if (state.selection.causes[v]) add(v, state.selection.name);
            });
        }
        return edges;
    }

    function buildCode() {
        var lines = ['dag {'];
        var nodeLine = function (name, attr) { return '"' + name + '"' + (attr ? ' [' + attr + ']' : ''); };
        lines.push(nodeLine(state.exposure, 'exposure'));
        lines.push(nodeLine(state.outcome, 'outcome'));
        state.others.forEach(function (o) { lines.push(nodeLine(o.name, o.measured ? null : 'latent')); });
        if (state.selection.enabled && state.selection.name) lines.push(nodeLine(state.selection.name, 'selected'));
        autoEdges().forEach(function (e) { lines.push('"' + e.from + '" -> "' + e.to + '"'); });
        lines.push('}');
        return lines.join('\n');
    }

    // ── Modal shell ─────────────────────────────────────────────────────────────

    function ensureRoot() {
        if (root) return;
        root = document.createElement('div');
        root.id = 'wiz-modal';
        root.className = 'modal-overlay';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.style.display = 'none';
        root.innerHTML =
            '<div class="modal-dialog wiz-dialog">' +
              '<div class="modal-header">' +
                '<h2 id="wiz-title"></h2>' +
                '<button type="button" class="modal-close" aria-label="Close" id="wiz-close">✕</button>' +
              '</div>' +
              '<div class="wiz-progress" id="wiz-progress" aria-hidden="true"></div>' +
              '<div class="modal-body wiz-body" id="wiz-body"></div>' +
              '<div class="modal-footer wiz-footer">' +
                '<button type="button" class="btn-secondary" id="wiz-back">Back</button>' +
                '<span style="flex:1 1 auto"></span>' +
                '<button type="button" class="btn-ghost" id="wiz-skip">Skip — I\'ll draw it myself</button>' +
                '<button type="button" id="wiz-next">Next</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(root);
        root.querySelector('#wiz-close').addEventListener('click', cancel);
        root.querySelector('#wiz-skip').addEventListener('click', cancel);
        root.querySelector('#wiz-back').addEventListener('click', back);
        root.querySelector('#wiz-next').addEventListener('click', next);
        root.addEventListener('click', function (e) { if (e.target === root) cancel(); });
        document.addEventListener('keydown', function (e) {
            if (root.style.display !== 'flex') return;
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
    }

    function show() {
        var step = STEPS[state.step];
        if (step.onEnter) step.onEnter();
        root.querySelector('#wiz-title').textContent = step.title;
        root.querySelector('#wiz-body').innerHTML = step.render();
        if (step.mount) step.mount();

        var prog = root.querySelector('#wiz-progress');
        prog.innerHTML = STEPS.map(function (s, i) {
            return '<span class="wiz-dot' + (i === state.step ? ' on' : '') + (i < state.step ? ' done' : '') + '"></span>';
        }).join('');

        root.querySelector('#wiz-back').style.visibility = state.step === 0 ? 'hidden' : 'visible';
        root.querySelector('#wiz-next').textContent = state.step === STEPS.length - 1 ? 'Create diagram' : 'Next';

        if (step.focus) {
            var f = root.querySelector('#' + step.focus);
            if (f) setTimeout(function () { f.focus(); }, 30);
        }
    }

    function next() {
        var step = STEPS[state.step];
        if (step.valid && !step.valid()) {
            var msg = step.invalidMsg ? step.invalidMsg() : 'Please complete this step.';
            var f = step.focus && root.querySelector('#' + step.focus);
            if (f) flash(f);
            announce(msg);
            return;
        }
        if (step.onLeave) step.onLeave();
        if (state.step === STEPS.length - 1) { finish(); return; }
        state.step++;
        show();
    }

    function back() {
        var step = STEPS[state.step];
        if (step.onLeave) step.onLeave();
        if (state.step > 0) { state.step--; show(); }
    }

    function announce(msg) {
        var body = root.querySelector('#wiz-body');
        var ex = body.querySelector('.wiz-error');
        if (ex) ex.remove();
        var p = document.createElement('p');
        p.className = 'wiz-error';
        p.textContent = msg;
        body.appendChild(p);
    }

    // ── Build & hand off ──────────────────────────────────────────────────────

    function finish() {
        var wantTour = root.querySelector('#wiz-tour') && root.querySelector('#wiz-tour').checked;

        if (window.BeginnerMode) {
            if (state.mode === 'beginner' && !BeginnerMode.active) BeginnerMode.toggle();
            if (state.mode === 'advanced' && BeginnerMode.active) BeginnerMode.toggle();
        }

        var code = buildCode();
        var ta = document.getElementById('adj_matrix');
        if (ta) ta.value = code;
        try {
            if (window.loadDAGFromTextData) loadDAGFromTextData();
            if (window.generateSpringLayout) generateSpringLayout();
        } catch (e) { /* leave the code in the panel for manual Update */ }

        hide();
        try { localStorage.setItem('dagitty_tour_done', '1'); } catch (e) {}

        if (wantTour && window.GuidedTour) setTimeout(function () { GuidedTour.start(); }, 250);
    }

    function start() {
        ensureRoot();
        state = {
            step: 0, mode: 'beginner', exposure: '', outcome: '', others: [],
            selection: { enabled: false, name: 'Selected', causes: {} }
        };
        root.style.display = 'flex';
        show();
    }
    function hide() { if (root) root.style.display = 'none'; }
    function cancel() { hide(); }

    window.DagWizard = { start: start };

})();
