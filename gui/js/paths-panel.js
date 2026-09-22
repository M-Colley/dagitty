/* DAGitty — Paths panel
 *
 * The canvas colours biasing paths and the Causal-effect panel gives a verdict,
 * but nothing ever LISTS the paths or says why each one is open or blocked.
 * For someone new to causal inference that explanation is the whole lesson:
 *
 *   E ← A → Z ← B → D   biasing · OPEN
 *   Open because you adjusted for Z, a collider on this path. Conditioning on a
 *   collider lets association flow through it. Remove that adjustment to close it.
 *
 * This panel enumerates every path between the exposure(s) and outcome(s),
 * classifies each as causal or biasing, works out whether it is open or blocked
 * under the current adjustment/selection set, names the variable responsible,
 * and highlights the path on the canvas on hover or focus.
 *
 * The path enumeration is GraphAnalyzer.listPaths(); the open/blocked rule is
 * the usual d-separation criterion applied along one path: a non-collider
 * blocks when it is conditioned on, a collider blocks unless it (or one of its
 * descendants) is conditioned on.
 */

(function () {
    'use strict';

    var LIMIT = 40;   // paths listed; beyond this the panel says "and more"

    function ids(vs) { return _.pluck(vs || [], 'id'); }
    function has(arr, x) { return arr.indexOf(x) !== -1; }
    function list(arr) {
        if (arr.length === 0) return '';
        if (arr.length === 1) return arr[0];
        if (arr.length === 2) return arr[0] + ' and ' + arr[1];
        return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
    }

    var ARROW = { '->': ' → ', '<-': ' ← ', '<->': ' ↔ ', '--': ' — ' };

    /**
     * Walk one path graph (as returned by GraphAnalyzer.listPaths: all the
     * vertices, but only the edges of a single path) from an exposure end to
     * the other end.
     * @returns {{nodes: string[], steps: string[]}|null}  steps[i] joins nodes[i]→nodes[i+1]
     */
    function walk(pg, sourceIds) {
        var edges = pg.getEdges();
        if (!edges.length) return null;
        var adj = {};
        edges.forEach(function (e) {
            (adj[e.v1.id] = adj[e.v1.id] || []).push(e);
            (adj[e.v2.id] = adj[e.v2.id] || []).push(e);
        });
        var ends = Object.keys(adj).filter(function (k) { return adj[k].length === 1; });
        var start = ends.filter(function (k) { return has(sourceIds, k); })[0];
        if (start === undefined) start = ends[0];
        if (start === undefined) return null;

        var nodes = [start], steps = [], cur = start, prev = null;
        for (var guard = 0; guard < 10000; guard++) {
            var next = (adj[cur] || []).filter(function (e) { return e !== prev; })[0];
            if (!next) break;
            var other = next.v1.id === cur ? next.v2.id : next.v1.id;
            var step;
            if (next.directed === Graph.Edgetype.Directed)        step = next.v1.id === cur ? '->' : '<-';
            else if (next.directed === Graph.Edgetype.Bidirected) step = '<->';
            else                                                  step = '--';
            steps.push(step);
            nodes.push(other);
            prev = next; cur = other;
        }
        return { nodes: nodes, steps: steps };
    }

    function pathText(nodes, steps) {
        var s = nodes[0];
        for (var i = 0; i < steps.length; i++) s += (ARROW[steps[i]] || ' — ') + nodes[i + 1];
        return s;
    }

    /** Classify one walked path under the current conditioning set. */
    function classify(w, ctx) {
        var nodes = w.nodes, steps = w.steps;
        var causal = steps.length > 0 && steps.every(function (s) { return s === '->'; });
        var blockers = [], openers = [], candidates = [];

        for (var i = 1; i < nodes.length - 1; i++) {
            var n = nodes[i];
            var inFromLeft  = steps[i - 1] === '->' || steps[i - 1] === '<->';
            var inFromRight = steps[i]     === '<-' || steps[i]     === '<->';
            if (inFromLeft && inFromRight) {                       // collider
                if (has(ctx.anZ, n)) openers.push({ node: n, viaDescendant: !has(ctx.Z, n) });
                else blockers.push({ node: n, collider: true });
            } else {                                               // non-collider
                if (has(ctx.Z, n)) blockers.push({ node: n, collider: false, selected: has(ctx.selected, n) && !has(ctx.adjusted, n) });
                else if (!has(ctx.latent, n)) candidates.push(n);
            }
        }
        var open = blockers.length === 0;
        var mediators = nodes.slice(1, -1);

        var explanation;
        if (causal) {
            if (open) {
                if (ctx.wantDirect && mediators.length) {
                    explanation = 'Causal path through ' + list(mediators) + ' — an indirect effect. For the ' +
                        'direct effect this path must be blocked: adjust for one of ' + list(mediators) + '.';
                } else if (mediators.length) {
                    explanation = 'Causal path — part of the effect you want to estimate, running through ' +
                        list(mediators) + '. Leave it open.';
                } else {
                    explanation = 'The direct causal arrow — the effect you want to estimate. Leave it open.';
                }
            } else {
                var meds = blockers.map(function (b) { return b.node; });
                explanation = ctx.wantDirect
                    ? 'Blocked by adjusting for ' + list(meds) + ' — intended when estimating a direct effect.'
                    : 'Blocked because you adjusted for ' + list(meds) + ', a mediator. For the total effect this ' +
                      'removes part of the very effect you are measuring — leave ' + list(meds) + ' unadjusted.';
            }
        } else if (open) {
            if (openers.length) {
                var o = openers[0];
                explanation = 'Open because you ' + (has(ctx.adjusted, o.node) || o.viaDescendant ? 'adjusted for' : 'selected on') +
                    ' ' + o.node + (o.viaDescendant ? ' (or something it causes)' : '') + ', a collider on this path. ' +
                    'Conditioning on a collider lets association flow through it. Remove that ' +
                    (has(ctx.selected, o.node) ? 'selection' : 'adjustment') + ' to close this path.';
            } else if (candidates.length) {
                explanation = 'Open: nothing on it is adjusted for. Adjusting for ' + list(candidates) +
                    ' would block it (the Causal-effect panel lists the combinations that block every path).';
            } else {
                explanation = 'Open, and every variable on it is unobserved — it cannot be blocked by adjustment. ' +
                    'This is an unmeasured confounding path.';
            }
        } else {
            var parts = [];
            var byAdj = blockers.filter(function (b) { return !b.collider && !b.selected; }).map(function (b) { return b.node; });
            var bySel = blockers.filter(function (b) { return !b.collider && b.selected; }).map(function (b) { return b.node; });
            var atCol = blockers.filter(function (b) { return b.collider; }).map(function (b) { return b.node; });
            if (byAdj.length) parts.push('blocked by adjusting for ' + list(byAdj));
            if (bySel.length) parts.push('blocked by selecting on ' + list(bySel));
            if (atCol.length) parts.push('blocked at ' + list(atCol) + ' — a collider you have not adjusted for. Keep it that way');
            explanation = parts.join('; ');
            explanation = explanation.charAt(0).toUpperCase() + explanation.slice(1) + '.';
        }

        return {
            nodes: nodes, steps: steps, text: pathText(nodes, steps),
            causal: causal, open: open, blockers: blockers, openers: openers,
            explanation: explanation
        };
    }

    /**
     * Analyse the paths between exposure(s) and outcome(s).
     * @param {Graph}  g
     * @param {string} kind  'total' | 'direct' (which effect the user is after)
     * @returns {null | {cyclic:boolean, paths:Array, truncated:boolean, openBiasing:number}}
     *          null when no exposure/outcome is set.
     */
    function analyse(g, kind) {
        if (!g) return null;
        var X = g.getSources(), Y = g.getTargets();
        if (!X.length || !Y.length) return null;
        if (GraphAnalyzer.containsCycle(g)) return { cyclic: true, paths: [], truncated: false, openBiasing: 0 };

        var adjusted = ids(g.getAdjustedNodes());
        var selected = ids(g.getSelectedNodes());
        var Z = _.union(adjusted, selected);
        var anZ = Z.length ? _.union(Z, ids(g.ancestorsOf(g.getVertex(Z)))) : [];
        var ctx = {
            Z: Z, anZ: anZ, adjusted: adjusted, selected: selected,
            latent: ids(g.getLatentNodes()), wantDirect: kind === 'direct'
        };

        var pgs = GraphAnalyzer.listPaths(g, false, LIMIT + 1, X, Y);
        if (!pgs || typeof pgs === 'string') pgs = [];
        var truncated = pgs.length > LIMIT;
        var xids = ids(X);
        var paths = pgs.slice(0, LIMIT).map(function (pg) {
            var w = walk(pg, xids);
            return w ? classify(w, ctx) : null;
        }).filter(Boolean);

        // Open biasing paths first (they are the problem), then causal, then blocked.
        paths.sort(function (a, b) {
            var ka = (a.open ? 0 : 2) + (a.causal ? 1 : 0), kb = (b.open ? 0 : 2) + (b.causal ? 1 : 0);
            return ka - kb || a.nodes.length - b.nodes.length || (a.text < b.text ? -1 : 1);
        });

        return {
            cyclic: false, paths: paths, truncated: truncated,
            openBiasing: paths.filter(function (p) { return p.open && !p.causal; }).length
        };
    }

    // ── Canvas highlighting ───────────────────────────────────────────────

    function edgeShapesBetween(view, a, b) {
        var out = [];
        if (!view || !view.edge_shapes) return out;
        Object.keys(Graph.Edgetype).forEach(function (k) {
            var t = Graph.Edgetype[k];
            if (typeof t !== 'number') return;
            [a + '\0' + b + '\0' + t, b + '\0' + a + '\0' + t].forEach(function (key) {
                var es = view.edge_shapes.get(key);
                if (es && es.dom) out.push(es);
            });
        });
        return out;
    }

    function highlight(p, on) {
        if (!window.DAGittyControl || !DAGittyControl.getView) return;
        var view = DAGittyControl.getView();
        var canvas = document.getElementById('canvas');
        if (canvas) canvas.classList.toggle('path-focus', !!on);
        for (var i = 0; i < p.nodes.length - 1; i++) {
            edgeShapesBetween(view, p.nodes[i], p.nodes[i + 1]).forEach(function (es) {
                es.dom.classList.toggle('path-hl', !!on);
            });
        }
        p.nodes.forEach(function (n) {
            var vs = view.getVertexShape && view.getVertexShape(n);
            if (vs && vs.dom) vs.dom.classList.toggle('vertex-hl', !!on);
        });
    }

    function clearHighlight() {
        var canvas = document.getElementById('canvas');
        if (!canvas) return;
        canvas.classList.remove('path-focus');
        canvas.querySelectorAll('.path-hl, .vertex-hl').forEach(function (el) {
            el.classList.remove('path-hl', 'vertex-hl');
        });
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    function currentKind() {
        var el = document.getElementById('causal_effect_kind');
        return (el && el.value === 'adj_direct') ? 'direct' : 'total';
    }

    function render() {
        var host = document.getElementById('paths_panel');
        if (!host) return;
        clearHighlight();
        host.replaceChildren();
        var g = (window.Model && Model.dag) ? Model.dag : null;
        var res = analyse(g, currentKind());
        var badge = document.getElementById('paths_count');

        var hint = function (text) {
            var p = document.createElement('p');
            p.className = 'rlegend-hint';
            p.textContent = text;
            host.appendChild(p);
        };

        if (!res) {
            hint('Set an exposure and an outcome to list the paths between them.');
            if (badge) badge.style.display = 'none';
            return;
        }
        if (res.cyclic) {
            hint('The diagram contains a cycle, so paths cannot be classified until it is removed.');
            if (badge) badge.style.display = 'none';
            return;
        }
        if (!res.paths.length) {
            hint('There is no path of any kind between the exposure and the outcome.');
            if (badge) badge.style.display = 'none';
            return;
        }

        if (badge) {
            badge.textContent = res.openBiasing ? res.openBiasing + ' open' : '';
            badge.style.display = res.openBiasing ? '' : 'none';
        }

        hint('Every path between exposure and outcome. Hover or focus one to see it on the canvas. ' +
             'Causal paths should stay open; biasing paths must all be blocked.');

        var ul = document.createElement('ul');
        ul.className = 'paths-list';
        res.paths.forEach(function (p) {
            var li = document.createElement('li');
            li.className = 'path-item ' + (p.causal ? 'path-causal' : 'path-biasing') + (p.open ? ' path-open' : ' path-blocked');
            li.tabIndex = 0;

            var head = document.createElement('div');
            head.className = 'path-head';
            var route = document.createElement('code');
            route.className = 'path-route';
            route.textContent = p.text;
            head.appendChild(route);
            var tag = document.createElement('span');
            tag.className = 'path-tag';
            tag.textContent = (p.causal ? 'causal' : 'biasing') + ' · ' + (p.open ? 'open' : 'blocked');
            head.appendChild(tag);
            li.appendChild(head);

            var why = document.createElement('div');
            why.className = 'path-why';
            why.textContent = p.explanation;
            li.appendChild(why);

            li.addEventListener('mouseenter', function () { highlight(p, true); });
            li.addEventListener('mouseleave', function () { highlight(p, false); });
            li.addEventListener('focus',      function () { highlight(p, true); });
            li.addEventListener('blur',       function () { highlight(p, false); });
            ul.appendChild(li);
        });
        host.appendChild(ul);

        if (res.truncated) hint('Only the first ' + LIMIT + ' paths are shown.');
    }

    var _timer = null;
    function renderDebounced() {
        if (_timer) clearTimeout(_timer);
        _timer = setTimeout(function () { _timer = null; render(); }, 220);
    }

    window.Paths = { analyse: analyse, refresh: render, walk: walk, highlight: highlight, clearHighlight: clearHighlight };

    window.addEventListener('load', function () {
        if (window.DAGittyControl) DAGittyControl.observe('graphchange', renderDebounced);
        var kindEl = document.getElementById('causal_effect_kind');
        if (kindEl) kindEl.addEventListener('change', renderDebounced);
        setTimeout(render, 140);
    });

})();
