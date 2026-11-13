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
    var returnFocus = null;

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function clean(name) { return String(name || '').trim(); }
    function quote(name) { return '"' + name.replace(/"/g, '\\"') + '"'; }
    function nameError(name, current) {
        if (!name) return 'Enter a variable name.';
        if (/[\\\x00-\x1f\x7f]/.test(name)) return 'Use a name without backslashes or control characters.';
        if (name === 'graph' || name === 'node' || Object.prototype.hasOwnProperty.call(Object.prototype, name)) return '“' + name + '” is reserved by the diagram engine. Choose a different variable name.';
        var taken = [];
        if (current !== 'exposure') taken.push(state.exposure);
        if (current !== 'outcome') taken.push(state.outcome);
        state.others.forEach(function (o, i) { if (current !== i) taken.push(o.name); });
        if (current !== 'selection' && state.selection.enabled) taken.push(state.selection.name);
        return taken.indexOf(name) >= 0 ? 'Each variable needs a different name: “' + name + '” is already in use.' : '';
    }

    // ── Steps ───────────────────────────────────────────────────────────────────

    var STEPS = [
        {
            title: 'Build a causal diagram, step by step',
            render: function () {
                return '' +
                  '<p class="wiz-lead">A <strong>causal diagram</strong> (a DAG) is a picture of what you believe ' +
                  'causes what. We\'ll build one together in a few short steps — you can edit everything afterwards.</p>' +
                  '<fieldset class="wiz-fieldset"><legend>How much do you want to see?</legend>' +
                    '<label class="wiz-radio"><input type="radio" name="wiz-mode" value="beginner"' + (state.mode === 'beginner' ? ' checked' : '') + '> ' +
                      '<span><strong>Beginner</strong> — a simplified interface with just the essentials. ' +
                      '<span class="wiz-muted">Recommended if you\'re new to causal inference.</span></span></label>' +
                    '<label class="wiz-radio"><input type="radio" name="wiz-mode" value="advanced"' + (state.mode === 'advanced' ? ' checked' : '') + '> ' +
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
                  '<p class="wiz-eg">e.g. <em>taking a specified drug versus no treatment, or one additional hour of daily screen time over two weeks.</em></p>' +
                  '<p class="wiz-sub">Choose a clear comparison and time window for your research question. You can keep the variable name short.</p>' +
                  '<label class="wiz-input-label">Exposure variable name' +
                    '<input type="text" id="wiz-exposure" class="wiz-input" placeholder="e.g. Treatment" ' +
                    'value="' + esc(state.exposure) + '" autocomplete="off"></label>';
            },
            focus: 'wiz-exposure',
            enterAdvances: true,
            valid: function () { return !nameError(clean(root.querySelector('#wiz-exposure').value), 'exposure'); },
            invalidMsg: function () { return nameError(clean(root.querySelector('#wiz-exposure').value), 'exposure'); },
            onLeave: function () { state.exposure = clean(root.querySelector('#wiz-exposure').value); }
        },
        {
            title: 'What is the effect you want to explain?',
            render: function () {
                return '' +
                  '<p class="wiz-lead">The <span class="wiz-term">outcome</span> is the effect you\'re trying to ' +
                  'understand — what the exposure might change.</p>' +
                  '<p class="wiz-eg">e.g. <em>recovery after four weeks, test score at the end of term, disease status.</em></p>' +
                  '<label class="wiz-input-label">Outcome variable name' +
                    '<input type="text" id="wiz-outcome" class="wiz-input" placeholder="e.g. Recovery" ' +
                    'value="' + esc(state.outcome) + '" autocomplete="off"></label>';
            },
            focus: 'wiz-outcome',
            enterAdvances: true,
            valid: function () {
                var o = clean(root.querySelector('#wiz-outcome').value);
                return !nameError(o, 'outcome');
            },
            invalidMsg: function () {
                var o = clean(root.querySelector('#wiz-outcome').value);
                return nameError(o, 'outcome');
            },
            onLeave: function () { state.outcome = clean(root.querySelector('#wiz-outcome').value); }
        },
        {
            title: 'Add any other relevant variables',
            render: function () {
                return '' +
                  '<p class="wiz-lead">Add other variables that matter for the ' +
                  '<strong>' + esc(state.exposure || 'exposure') + ' → ' + esc(state.outcome || 'outcome') + '</strong> ' +
                  'relationship. Pick a role if you know it — we\'ll suggest arrows for that role, and you can fine-tune them ' +
                  'on the canvas afterwards. Mark whether each is <strong>measured</strong>: unmeasured variables ' +
                  'become unobserved (latent) and can\'t be adjusted for. This step is optional.</p>' +
                  '<dl class="wiz-defs">' +
                    '<div><dt>Confounder</dt><dd>a common cause of both the exposure and the outcome ' +
                      '(can create a noncausal association; may need to be adjusted for).</dd></div>' +
                    '<div><dt>Mediator</dt><dd>sits on the causal pathway: exposure → mediator → outcome ' +
                      '(part of how the effect happens).</dd></div>' +
                    '<div><dt>Collider</dt><dd>a common effect of two variables ' +
                      '(adjusting for it can <em>create</em> bias).</dd></div>' +
                    '<div><dt>Other / not sure yet</dt><dd>no arrows added automatically; connect it in the editor.</dd></div>' +
                  '</dl>' +
                  '<div class="wiz-add-row">' +
                    '<label class="wiz-input-label">Variable name<input type="text" id="wiz-var-name" class="wiz-input" placeholder="Variable name" autocomplete="off"></label>' +
                    '<div class="wiz-input-label"><label for="wiz-var-role">Node type</label><select id="wiz-var-role" class="wiz-input">' +
                      '<option value="other">Other / not sure yet</option>' +
                      '<option value="confounder">Confounder</option>' +
                      '<option value="mediator">Mediator</option>' +
                      '<option value="collider">Collider</option>' +
                    '</select></div>' +
                    '<label class="wiz-check wiz-measured"><input type="checkbox" id="wiz-var-measured" checked> measured</label>' +
                    '<button type="button" class="wiz-add-btn" id="wiz-add-var">Add</button>' +
                    '<button type="button" class="btn-secondary" id="wiz-cancel-edit" hidden>Cancel edit</button>' +
                  '</div>' +
                  '<p id="wiz-edit-status" class="wiz-edit-status" role="status"></p>' +
                  '<div id="wiz-var-list" class="wiz-var-table-wrap" role="region" aria-label="Other variables; scroll horizontally on small screens" tabindex="0"></div>';
            },
            focus: 'wiz-var-name',
            mount: function () {
                renderVarForm();
                var add = function () {
                    var nameEl = root.querySelector('#wiz-var-name');
                    var name = clean(nameEl.value);
                    var role = root.querySelector('#wiz-var-role').value;
                    var measured = root.querySelector('#wiz-var-measured').checked;
                    var error = nameError(name, state.editing ? state.editing.index : null);
                    if (error) { flash(nameEl); announce(error); nameEl.focus(); return; }
                    var variable = { name: name, role: role, measured: measured };
                    if (state.editing) {
                        var oldName = state.others[state.editing.index].name;
                        state.others[state.editing.index] = variable;
                        if (oldName !== name) {
                            if (state.selection.causes[oldName]) state.selection.causes[name] = true;
                            delete state.selection.causes[oldName];
                        }
                        state.editing = null;
                    } else {
                        state.others.push(variable);
                        state.pending = { name: '', role: 'other', measured: true };
                    }
                    renderVarForm();
                    nameEl.focus();
                    var oldError = root.querySelector('.wiz-error');
                    if (oldError) oldError.remove();
                    renderVarList();
                };
                root.querySelector('#wiz-add-var').addEventListener('click', add);
                root.querySelector('#wiz-cancel-edit').addEventListener('click', function () {
                    state.editing = null;
                    renderVarForm();
                    var oldError = root.querySelector('.wiz-error');
                    if (oldError) oldError.remove();
                    root.querySelector('#wiz-var-name').focus();
                });
                root.querySelector('#wiz-var-name').addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); add(); }
                });
                renderVarList();
            },
            valid: function () { return !state.editing && !clean(root.querySelector('#wiz-var-name').value); },
            invalidMsg: function () {
                return state.editing ? 'Choose Save changes or Cancel edit before continuing.' :
                    'Choose Add to include the variable you typed, or clear its name to continue.';
            },
            onLeave: saveVarDraft
        },
        {
            title: 'Did selection into the sample play a role?',
            render: function () {
                return '' +
                  '<p class="wiz-lead">Optional but valuable. A <span class="wiz-term">selection node</span> represents ' +
                  'whether someone ended up in your sample (e.g. "agreed to join the study", "wasn\'t lost to ' +
                  'follow-up"). Because everyone in your data <em>is</em> selected, the analysis conditions on it — so ' +
                  'if selection is a common effect on a path between exposure and outcome, conditioning on it ' +
                  'can open that path and introduce <strong>selection bias</strong>. An arrow into selection by itself ' +
                  'does not establish bias.</p>' +
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
                    var selected = [];
                    grid.querySelectorAll('input:checked').forEach(function (cb) { selected.push(cb.getAttribute('data-cause')); });
                    if (w) w.style.display = selected.indexOf(state.exposure) >= 0 && selected.indexOf(state.outcome) >= 0 ? 'block' : 'none';
                };
                allVarNames().forEach(function (n) {
                    var lbl = document.createElement('label');
                    lbl.className = 'wiz-check';
                    var cb = document.createElement('input');
                    cb.type = 'checkbox'; cb.checked = state.selection.causes[n] === true;
                    cb.setAttribute('data-cause', n);
                    cb.addEventListener('change', warn);
                    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + n));
                    grid.appendChild(lbl);
                });
                warn();
            },
            valid: function () {
                return !root.querySelector('#wiz-sel-enabled').checked ||
                    !nameError(clean(root.querySelector('#wiz-sel-name').value), 'selection');
            },
            invalidMsg: function () { return nameError(clean(root.querySelector('#wiz-sel-name').value), 'selection'); },
            onLeave: function () {
                var enabledEl = root.querySelector('#wiz-sel-enabled');
                state.selection.enabled = !!(enabledEl && enabledEl.checked);
                var nameEl = root.querySelector('#wiz-sel-name');
                if (nameEl) state.selection.name = clean(nameEl.value);
                state.selection.causes = Object.create(null);
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
                  ' (suggested from the roles you chose, including a direct exposure → outcome arrow). These are ' +
                  '<strong>starting assumptions, not findings from data</strong>. Review them in the editor before ' +
                  'using the adjustment advice; an omitted arrow is also a causal assumption.</p>' +
                  '<div class="wiz-summary">' +
                    '<p><span class="wiz-pill wiz-pill-exp">exposure</span> ' + esc(state.exposure || '—') + '</p>' +
                    '<p><span class="wiz-pill wiz-pill-out">outcome</span> ' + esc(state.outcome || '—') + '</p>' +
                    (state.others.length ? '<p><span class="wiz-pill">others</span> ' +
                        esc(state.others.map(function (o) { return o.name; }).join(', ')) + '</p>' : '') +
                    (unmeasured.length ? '<p><span class="wiz-pill">unobserved</span> ' + esc(unmeasured.join(', ')) + '</p>' : '') +
                    (state.selection.enabled ? '<p><span class="wiz-pill">selection</span> ' + esc(state.selection.name) + '</p>' : '') +
                  '</div>' +
                  '<details class="wiz-summary"><summary>Review the suggested arrows (' + nEdges + ')</summary>' +
                    '<ul>' + autoEdges().map(function (e) { return '<li>' + esc(e.from) + ' → ' + esc(e.to) + '</li>'; }).join('') + '</ul>' +
                    '<p>You can remove or change any of these arrows on the canvas or with “Edit as a list”.</p>' +
                  '</details>' +
                  '<p class="wiz-sub">Creating this diagram replaces the current diagram in the editor.</p>' +
                  '<label class="wiz-check"><input type="checkbox" id="wiz-tour"' + (state.wantTour ? ' checked' : '') + '> ' +
                    'Give me a quick tour of the interface afterwards</label>';
            },
            onLeave: function () { state.wantTour = root.querySelector('#wiz-tour').checked; }
        }
    ];

    // ── Sub-renderers ─────────────────────────────────────────────────────────

    function saveVarDraft() {
        var draft = state.editing || state.pending;
        draft.name = root.querySelector('#wiz-var-name').value;
        draft.role = root.querySelector('#wiz-var-role').value;
        draft.measured = root.querySelector('#wiz-var-measured').checked;
    }

    function renderVarForm() {
        var draft = state.editing || state.pending;
        root.querySelector('#wiz-var-name').value = draft.name;
        root.querySelector('#wiz-var-role').value = draft.role;
        root.querySelector('#wiz-var-measured').checked = draft.measured;
        root.querySelector('#wiz-add-var').textContent = state.editing ? 'Save changes' : 'Add';
        root.querySelector('#wiz-cancel-edit').hidden = !state.editing;
        root.querySelector('#wiz-edit-status').textContent = state.editing ?
            'Editing ' + state.others[state.editing.index].name + '. Save changes to update this variable.' : '';
    }

    function renderVarList() {
        var list = root.querySelector('#wiz-var-list');
        if (!list) return;
        list.innerHTML = '';
        if (!state.others.length) {
            list.innerHTML = '<p class="wiz-empty">No other variables yet (optional).</p>';
            return;
        }
        list.innerHTML = '<table class="wiz-var-table"><caption>Other variables</caption>' +
            '<thead><tr><th scope="col">Variable name</th><th scope="col">Node type</th>' +
            '<th scope="col">Measured</th><th scope="col">Actions</th></tr></thead><tbody></tbody></table>';
        var body = list.querySelector('tbody');
        var labels = { other: 'Other / not sure yet', confounder: 'Confounder', mediator: 'Mediator', collider: 'Collider' };
        state.others.forEach(function (o, i) {
            var row = document.createElement('tr');
            row.innerHTML = '<th scope="row">' + esc(o.name) + '</th><td>' + labels[o.role] +
                '</td><td>' + (o.measured ? 'Yes' : 'No (unobserved)') + '</td><td class="wiz-var-actions">' +
                '<button type="button" data-action="edit" aria-label="Edit ' + esc(o.name) + '">Edit</button> ' +
                '<button type="button" data-action="remove" aria-label="Remove ' + esc(o.name) + '">Remove</button></td>';
            row.querySelector('[data-action="edit"]').addEventListener('click', function () {
                if (state.editing) {
                    announce('Save changes or Cancel edit before editing another variable.');
                } else {
                    saveVarDraft();
                    state.editing = { index: i, name: o.name, role: o.role, measured: o.measured };
                    renderVarForm();
                }
                root.querySelector('#wiz-var-name').focus();
            });
            row.querySelector('[data-action="remove"]').addEventListener('click', function () {
                saveVarDraft();
                var removed = state.others.splice(i, 1)[0];
                if (removed) delete state.selection.causes[removed.name];
                if (state.editing) {
                    if (state.editing.index === i) state.editing = null;
                    else if (state.editing.index > i) state.editing.index--;
                }
                renderVarForm();
                renderVarList();
                root.querySelector('#wiz-var-name').focus();
            });
            body.appendChild(row);
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
                if (state.selection.causes[v] && allVarNames().indexOf(v) >= 0) add(v, state.selection.name);
            });
        }
        return edges;
    }

    function buildCode() {
        var lines = ['dag {'];
        var nodeLine = function (name, attr) { return quote(name) + (attr ? ' [' + attr + ']' : ''); };
        lines.push(nodeLine(state.exposure, 'exposure'));
        lines.push(nodeLine(state.outcome, 'outcome'));
        state.others.forEach(function (o) { lines.push(nodeLine(o.name, o.measured ? null : 'latent')); });
        if (state.selection.enabled && state.selection.name) lines.push(nodeLine(state.selection.name, 'selected'));
        autoEdges().forEach(function (e) { lines.push(quote(e.from) + ' -> ' + quote(e.to)); });
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
        root.setAttribute('aria-labelledby', 'wiz-title');
        root.style.display = 'none';
        root.innerHTML =
            '<div class="modal-dialog wiz-dialog">' +
              '<div class="modal-header">' +
                '<h2 id="wiz-title" tabindex="-1"></h2>' +
                '<button type="button" class="modal-close" aria-label="Close" id="wiz-close">✕</button>' +
              '</div>' +
              '<div class="wiz-progress" id="wiz-progress" role="progressbar" aria-label="Diagram builder progress" aria-valuemin="1" aria-valuemax="' + STEPS.length + '"></div>' +
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
        // Closing is explicit: an accidental click outside must not lose a draft.
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
        prog.setAttribute('aria-valuenow', String(state.step + 1));
        prog.setAttribute('aria-valuetext', 'Step ' + (state.step + 1) + ' of ' + STEPS.length + ': ' + step.title);
        prog.innerHTML = STEPS.map(function (s, i) {
            return '<span aria-hidden="true" class="wiz-dot' + (i === state.step ? ' on' : '') + (i < state.step ? ' done' : '') + '"></span>';
        }).join('');

        root.querySelector('#wiz-back').style.visibility = state.step === 0 ? 'hidden' : 'visible';
        root.querySelector('#wiz-next').textContent = state.step === STEPS.length - 1 ? 'Create diagram' : 'Next';

        if (step.focus) {
            var f = root.querySelector('#' + step.focus);
            if (f) {
                f.focus();
                // Type a name, press Enter, move on — the natural rhythm for a
                // single-field step. (The variables step wires Enter to "Add".)
                if (step.enterAdvances) f.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); next(); }
                });
            }
        } else root.querySelector('#wiz-title').focus();
    }

    function next() {
        var step = STEPS[state.step];
        if (step.valid && !step.valid()) {
            var msg = step.invalidMsg ? step.invalidMsg() : 'Please complete this step.';
            var f = step.focus && root.querySelector('#' + step.focus);
            if (f) flash(f);
            announce(msg);
            if (f) f.focus();
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
        p.setAttribute('role', 'alert');
        p.textContent = msg;
        body.appendChild(p);
    }

    // ── Build & hand off ──────────────────────────────────────────────────────

    function finish() {
        var wantTour = root.querySelector('#wiz-tour') && root.querySelector('#wiz-tour').checked;
        var ta = document.getElementById('adj_matrix');
        if (ta && ta.classList.contains('dirty')) {
            announce('Your model code has unapplied changes. Close this builder and update or save that code before creating a new diagram. Your builder draft will be kept.');
            return;
        }

        var code = buildCode();
        var previousCode = ta ? ta.value : '';
        try {
            // Validate before replacing either the editor or the current diagram.
            if (window.GraphParser) GraphParser.parseGuess(code);
            if (!window.loadDAGFromTextData) throw new Error('The editor is not ready yet.');
            if (ta) ta.value = code;
            if (loadDAGFromTextData() === false) throw new Error('The editor could not read the diagram.');
        } catch (e) {
            if (ta) ta.value = previousCode;
            announce('The diagram could not be created. Your builder draft is still here; check the variable names and try again.');
            return;
        }

        if (window.BeginnerMode) {
            if (state.mode === 'beginner' && !BeginnerMode.active) BeginnerMode.toggle();
            if (state.mode === 'advanced' && BeginnerMode.active) BeginnerMode.toggle();
        }

        hide();
        state = null;
        try { localStorage.setItem('dagitty_tour_done', '1'); } catch (e) {}

        if (wantTour && window.GuidedTour) setTimeout(function () { GuidedTour.start(); }, 250);
    }

    function start() {
        ensureRoot();
        returnFocus = document.activeElement;
        if (!state) state = {
            step: 0, mode: 'beginner', exposure: '', outcome: '', others: [],
            pending: { name: '', role: 'other', measured: true }, editing: null, wantTour: true,
            selection: { enabled: false, name: 'Selected', causes: Object.create(null) }
        };
        root.style.display = 'flex';
        show();
    }
    function hide() {
        if (root) root.style.display = 'none';
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
    }
    function cancel() {
        if (state) {
            var step = STEPS[state.step];
            if (step.onLeave) step.onLeave();
        }
        hide();
    }

    window.DagWizard = { start: start };

})();
