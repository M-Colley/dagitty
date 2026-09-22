/* DAGitty — Structured (list) editor
 *
 * The canvas is mouse-only and invisible to a screen reader, and the model-code
 * box asks people to learn a DOT-like syntax. This dialog is a third way in:
 * a table of variables (name + role) and a table of arrows (from, type, to),
 * fully operable from the keyboard, with every change announced to assistive
 * technology and applied to the live diagram through the normal controller so
 * undo, autosave and every analysis panel keep working.
 */

(function () {
    'use strict';

    var ROLES = [
        { value: 'none',         label: 'none' },
        { value: 'source',       label: 'exposure (cause)' },
        { value: 'target',       label: 'outcome (effect)' },
        { value: 'adjustedNode', label: 'adjusted (controlled for)' },
        { value: 'selectedNode', label: 'sample selection' },
        { value: 'latentNode',   label: 'unobserved (latent)' }
    ];
    var ROLE_LABEL = {};
    ROLES.forEach(function (r) { ROLE_LABEL[r.value] = r.label; });

    var TYPES = [
        { value: 'directed',   label: '→ causes' },
        { value: 'bidirected', label: '↔ share an unmeasured cause' }
    ];

    var root = null, open = false, pendingFocus = null;

    function g() { return (window.Model && Model.dag) ? Model.dag : null; }
    function clean(s) { return String(s || '').replace(/["{}]/g, '').trim(); }

    /** The single role DAGitty stores for a vertex (roles are mutually exclusive). */
    function roleOf(graph, v) {
        if (graph.isSource(v)) return 'source';
        if (graph.isTarget(v)) return 'target';
        if (graph.isAdjustedNode(v)) return 'adjustedNode';
        if (graph.isSelectedNode(v)) return 'selectedNode';
        if (graph.isLatentNode(v)) return 'latentNode';
        return 'none';
    }

    /** Where to put a variable added without a mouse position: just right of
     *  the current drawing, staggered so successive additions do not overlap. */
    function placeNew(graph) {
        var vs = graph.getVertices();
        if (!vs.length) return [0, 0];
        var xs = vs.map(function (v) { return v.layout_pos_x; }).filter(isFinite);
        var ys = vs.map(function (v) { return v.layout_pos_y; }).filter(isFinite);
        if (!xs.length || !ys.length) return [0, 0];
        var maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys);
        return [maxX + 1.2, minY + 0.9 * (vs.length % 4)];
    }

    function edgeBetween(graph, a, b) {
        var types = [Graph.Edgetype.Directed, Graph.Edgetype.Bidirected, Graph.Edgetype.Undirected];
        for (var i = 0; i < types.length; i++) {
            var e = graph.getEdge(a, b, types[i]) || graph.getEdge(b, a, types[i]);
            if (e) return e;
        }
        return null;
    }

    // ── Actions (all through the controller, so the canvas + undo stay in sync) ──

    function addVariable(name) {
        var graph = g(); name = clean(name);
        if (!name) { announce('Enter a name for the new variable.'); return false; }
        if (graph.getVertex(name)) { announce('A variable called ' + name + ' already exists.'); return false; }
        var p = placeNew(graph);
        DAGittyControl.newVertex(name, p[0], p[1]);
        announce('Added variable ' + name + '.');
        return true;
    }

    function removeVariable(id) {
        DAGittyControl.deleteVertex(id);
        announce('Removed variable ' + id + ' and its arrows.');
    }

    function renameVariable(oldId, newName) {
        var graph = g(); newName = clean(newName);
        if (newName === oldId) return true;
        if (!newName) { announce('The name cannot be empty; kept ' + oldId + '.'); return false; }
        if (graph.getVertex(newName)) { announce('A variable called ' + newName + ' already exists; kept ' + oldId + '.'); return false; }
        DAGittyControl.renameVertex(oldId, newName);
        announce('Renamed ' + oldId + ' to ' + newName + '.');
        return true;
    }

    function setRole(id, role) {
        var graph = g(), v = graph.getVertex(id);
        if (!v) return;
        var cur = roleOf(graph, v);
        if (cur === role) return;
        if (role === 'none') DAGittyControl.unsetVertexProperty(id, cur);
        else DAGittyControl.setVertexProperty(id, role);   // clears any other role first
        announce(id + ' is now ' + (role === 'none' ? 'an ordinary variable' : ROLE_LABEL[role]) + '.');
    }

    function addArrow(from, to, type) {
        var graph = g();
        if (!from || !to) { announce('Choose both ends of the arrow.'); return false; }
        if (from === to) { announce('An arrow cannot start and end at the same variable.'); return false; }
        var ex = edgeBetween(graph, from, to);
        if (ex) { announce(from + ' and ' + to + ' are already connected. Remove that arrow first to change it.'); return false; }
        var et = type === 'bidirected' ? Graph.Edgetype.Bidirected : Graph.Edgetype.Directed;
        DAGittyControl.getObservedGraph().addEdge(from, to, et);
        announce('Added ' + from + (et === Graph.Edgetype.Bidirected ? ' ↔ ' : ' → ') + to + '.');
        return true;
    }

    function removeArrow(e) {
        DAGittyControl.getObservedGraph().deleteEdge(e.v1.id, e.v2.id, e.directed);
        announce('Removed the arrow between ' + e.v1.id + ' and ' + e.v2.id + '.');
    }

    // ── Dialog ────────────────────────────────────────────────────────────

    function ensureRoot() {
        if (root) return;
        root = document.createElement('div');
        root.id = 'se-modal';
        root.className = 'modal-overlay';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'se-title');
        root.style.display = 'none';
        root.innerHTML =
            '<div class="modal-dialog modal-dialog-wide se-dialog">' +
              '<div class="modal-header">' +
                '<h2 id="se-title">Edit the diagram as a list</h2>' +
                '<button type="button" class="modal-close" aria-label="Close" id="se-close">✕</button>' +
              '</div>' +
              '<div class="modal-body">' +
                '<p class="modal-intro">Everything you can draw on the canvas, as two tables you can edit with the keyboard. ' +
                  'Changes apply to the diagram immediately and can be undone with Ctrl+Z.</p>' +
                '<div class="se-grid">' +
                  '<section aria-labelledby="se-vars-h">' +
                    '<h3 id="se-vars-h" class="se-h">Variables</h3>' +
                    '<table class="se-table" id="se-vars"><thead><tr><th scope="col">Name</th><th scope="col">Role</th>' +
                      '<th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody></tbody></table>' +
                    '<form class="se-add" id="se-add-var">' +
                      '<label class="sr-only" for="se-new-var">New variable name</label>' +
                      '<input type="text" id="se-new-var" placeholder="New variable name" autocomplete="off">' +
                      '<button type="submit">Add variable</button>' +
                    '</form>' +
                  '</section>' +
                  '<section aria-labelledby="se-arrows-h">' +
                    '<h3 id="se-arrows-h" class="se-h">Arrows</h3>' +
                    '<table class="se-table" id="se-arrows"><thead><tr><th scope="col">From</th><th scope="col">Type</th>' +
                      '<th scope="col">To</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody></tbody></table>' +
                    '<form class="se-add" id="se-add-arrow">' +
                      '<label class="sr-only" for="se-from">From</label><select id="se-from"></select>' +
                      '<label class="sr-only" for="se-type">Type</label><select id="se-type"></select>' +
                      '<label class="sr-only" for="se-to">To</label><select id="se-to"></select>' +
                      '<button type="submit">Add arrow</button>' +
                    '</form>' +
                  '</section>' +
                '</div>' +
                '<p id="se-live" class="se-live" role="status" aria-live="polite"></p>' +
              '</div>' +
              '<div class="modal-footer">' +
                '<button type="button" class="btn-secondary" id="se-tidy">Auto-arrange on canvas</button>' +
                '<button type="button" id="se-done">Done</button>' +
              '</div>' +
            '</div>';
        document.body.appendChild(root);

        root.querySelector('#se-close').addEventListener('click', close);
        root.querySelector('#se-done').addEventListener('click', close);
        root.querySelector('#se-tidy').addEventListener('click', function () {
            if (window.generateSpringLayout) { generateSpringLayout(); announce('Variables re-arranged on the canvas.'); }
        });
        root.addEventListener('click', function (e) { if (e.target === root) close(); });
        document.addEventListener('keydown', function (e) {
            if (open && e.key === 'Escape') { e.preventDefault(); close(); }
        });

        root.querySelector('#se-add-var').addEventListener('submit', function (e) {
            e.preventDefault();
            var input = root.querySelector('#se-new-var');
            if (addVariable(input.value)) input.value = '';
            pendingFocus = '#se-new-var';
        });
        root.querySelector('#se-add-arrow').addEventListener('submit', function (e) {
            e.preventDefault();
            var from = root.querySelector('#se-from').value, to = root.querySelector('#se-to').value,
                type = root.querySelector('#se-type').value;
            addArrow(from, to, type);
            pendingFocus = '#se-from';
        });
        var typeSel = root.querySelector('#se-type');
        TYPES.forEach(function (t) {
            var o = document.createElement('option');
            o.value = t.value; o.textContent = t.label;
            typeSel.appendChild(o);
        });
    }

    function announce(msg) {
        if (!root) return;
        var live = root.querySelector('#se-live');
        live.textContent = '';
        setTimeout(function () { live.textContent = msg; }, 20);   // re-announce identical messages
    }

    function fillSelect(sel, names, keep) {
        var prev = keep ? sel.value : '';
        sel.innerHTML = '';
        names.forEach(function (n) {
            var o = document.createElement('option');
            o.value = n; o.textContent = n;
            sel.appendChild(o);
        });
        if (prev && names.indexOf(prev) !== -1) sel.value = prev;
    }

    function render() {
        if (!root) return;
        var graph = g();
        if (!graph) return;
        var names = _.pluck(graph.getVertices(), 'id').sort();

        // Variables
        var vb = root.querySelector('#se-vars tbody');
        vb.innerHTML = '';
        if (!names.length) {
            var tr0 = document.createElement('tr');
            var td0 = document.createElement('td');
            td0.colSpan = 3; td0.className = 'se-empty'; td0.textContent = 'No variables yet — add one below.';
            tr0.appendChild(td0); vb.appendChild(tr0);
        }
        names.forEach(function (id) {
            var v = graph.getVertex(id);
            var tr = document.createElement('tr');

            var tdName = document.createElement('td');
            var inp = document.createElement('input');
            inp.type = 'text'; inp.value = id; inp.className = 'se-name';
            inp.setAttribute('aria-label', 'Name of variable ' + id);
            inp.dataset.focus = 'name:' + id;
            var commit = function () {
                if (inp.value === id) return;
                pendingFocus = '[data-focus="name:' + cssEsc(clean(inp.value) || id) + '"]';
                if (!renameVariable(id, inp.value)) { inp.value = id; pendingFocus = null; }
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { inp.value = id; e.stopPropagation(); }
            });
            tdName.appendChild(inp);
            tr.appendChild(tdName);

            var tdRole = document.createElement('td');
            var sel = document.createElement('select');
            sel.setAttribute('aria-label', 'Role of ' + id);
            sel.dataset.focus = 'role:' + id;
            ROLES.forEach(function (r) {
                var o = document.createElement('option');
                o.value = r.value; o.textContent = r.label;
                sel.appendChild(o);
            });
            sel.value = roleOf(graph, v);
            sel.addEventListener('change', function () { pendingFocus = '[data-focus="role:' + cssEsc(id) + '"]'; setRole(id, sel.value); });
            tdRole.appendChild(sel);
            tr.appendChild(tdRole);

            var tdDel = document.createElement('td');
            var del = document.createElement('button');
            del.type = 'button'; del.className = 'btn-ghost se-remove'; del.textContent = '✕';
            del.setAttribute('aria-label', 'Remove variable ' + id);
            del.addEventListener('click', function () { pendingFocus = '#se-new-var'; removeVariable(id); });
            tdDel.appendChild(del);
            tr.appendChild(tdDel);
            vb.appendChild(tr);
        });

        // Arrows
        var ab = root.querySelector('#se-arrows tbody');
        ab.innerHTML = '';
        var edges = graph.getEdges().slice().sort(function (a, b) {
            return (a.v1.id + a.v2.id) < (b.v1.id + b.v2.id) ? -1 : 1;
        });
        if (!edges.length) {
            var tr1 = document.createElement('tr');
            var td1 = document.createElement('td');
            td1.colSpan = 4; td1.className = 'se-empty'; td1.textContent = 'No arrows yet.';
            tr1.appendChild(td1); ab.appendChild(tr1);
        }
        edges.forEach(function (e) {
            var tr = document.createElement('tr');
            var sym = e.directed === Graph.Edgetype.Directed ? '→' : e.directed === Graph.Edgetype.Bidirected ? '↔' : '—';
            [e.v1.id, sym, e.v2.id].forEach(function (t, i) {
                var td = document.createElement('td');
                td.textContent = t;
                if (i === 1) { td.className = 'se-sym'; td.setAttribute('aria-label', sym === '→' ? 'causes' : sym === '↔' ? 'shares an unmeasured cause with' : 'is linked to'); }
                tr.appendChild(td);
            });
            var tdDel = document.createElement('td');
            var del = document.createElement('button');
            del.type = 'button'; del.className = 'btn-ghost se-remove'; del.textContent = '✕';
            del.setAttribute('aria-label', 'Remove arrow from ' + e.v1.id + ' to ' + e.v2.id);
            del.addEventListener('click', function () { pendingFocus = '#se-from'; removeArrow(e); });
            tdDel.appendChild(del);
            tr.appendChild(tdDel);
            ab.appendChild(tr);
        });

        fillSelect(root.querySelector('#se-from'), names, true);
        fillSelect(root.querySelector('#se-to'), names, true);
        root.querySelector('#se-add-arrow button').disabled = names.length < 2;

        if (pendingFocus) {
            var f = root.querySelector(pendingFocus);
            pendingFocus = null;
            if (f) f.focus();
        }
    }

    function cssEsc(s) { return String(s).replace(/(["\\\]\[])/g, '\\$1'); }

    function show() {
        if (!g()) return;
        ensureRoot();
        open = true;
        root.style.display = 'flex';
        render();
        announce('');
        setTimeout(function () {
            var first = root.querySelector('#se-vars input, #se-new-var');
            if (first) first.focus();
        }, 40);
    }
    function close() { open = false; if (root) root.style.display = 'none'; }

    var _timer = null;
    window.addEventListener('load', function () {
        if (window.DAGittyControl) DAGittyControl.observe('graphchange', function () {
            if (!open) return;
            if (_timer) clearTimeout(_timer);
            _timer = setTimeout(function () { _timer = null; render(); }, 30);
        });
    });

    window.StructuredEditor = { open: show, close: close, placeNew: placeNew, roleOf: roleOf, edgeBetween: edgeBetween };

})();
