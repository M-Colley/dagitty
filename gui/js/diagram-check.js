/* DAGitty — Diagram check
 *
 * DAGitty already tells you *that* an adjustment set is wrong ("Incorrectly
 * adjusted"). For someone new to causal inference that is the least useful half
 * of the answer: they need to know *which* variable is the problem and *why*.
 *
 * This panel reads the current diagram and reports the specific mistakes that
 * trip people up most often — controlling for a mediator, controlling for a
 * consequence of the outcome, conditioning on a collider, selecting the sample
 * on a common effect, arrows drawn the wrong way round — in plain language,
 * naming the variable each time.
 *
 * Every check is deliberately conservative: it only fires on a structural
 * pattern that is genuinely suspect, and the wording says what to look at
 * rather than asserting the model is wrong.
 */

(function () {
    'use strict';

    function ids(vs) { return _.pluck(vs || [], 'id'); }

    /** Ancestors/descendants of a set, excluding the set itself. */
    function strictAncestors(g, vs) {
        if (!vs.length) return [];
        return _.difference(ids(g.ancestorsOf(vs)), ids(vs));
    }
    function strictDescendants(g, vs) {
        if (!vs.length) return [];
        return _.difference(ids(g.descendantsOf(vs)), ids(vs));
    }

    function has(arr, x) { return arr.indexOf(x) !== -1; }

    function list(arr) {
        if (arr.length === 0) return '';
        if (arr.length === 1) return arr[0];
        if (arr.length === 2) return arr[0] + ' and ' + arr[1];
        return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
    }

    /**
     * Analyse the current graph.
     * @returns {Array<{level:'error'|'warn'|'info'|'ok', text:string, subject?:string}>}
     */
    function analyse() {
        var g = (window.Model && Model.dag) ? Model.dag : null;
        if (!g) return [];

        var out = [];
        var verts = g.getVertices();

        if (verts.length === 0) {
            return [{ level: 'info', text: 'Your diagram is empty. Click the canvas to add a variable, ' +
                'or use Help → Build a DAG step-by-step.' }];
        }

        // ── Structural blockers ────────────────────────────────────────────
        var cycle = GraphAnalyzer.containsCycle(g);
        if (cycle) {
            // containsCycle joins the path with the HTML entity &rarr;; this
            // panel renders through textContent, so use the character itself.
            cycle = String(cycle).replace(/&rarr;/g, '→');
            out.push({ level: 'error', text: 'The arrows form a loop (' + cycle + '). A DAG cannot ' +
                'contain a cycle — no analysis can run until you remove or reverse one of those arrows.' });
            return out;   // everything below assumes acyclicity
        }

        var exposures = ids(g.getSources());
        var outcomes  = ids(g.getTargets());
        var adjusted  = ids(g.getAdjustedNodes());
        var selected  = ids(g.getSelectedNodes ? g.getSelectedNodes() : []);
        var latent    = ids(g.getLatentNodes());

        // ── Isolated variables ─────────────────────────────────────────────
        var isolated = [];
        verts.forEach(function (v) {
            if (v.getParents().length === 0 && v.getChildren().length === 0 &&
                v.getNeighbours().length === 0) isolated.push(v.id);
        });
        if (isolated.length) {
            out.push({ level: 'warn', subject: list(isolated),
                text: isolated.length === 1
                    ? ' has no arrows, so it plays no part in the analysis. Connect it to the rest of ' +
                      'the diagram, or remove it.'
                    : ' have no arrows, so they play no part in the analysis. Connect them to the rest ' +
                      'of the diagram, or remove them.' });
        }

        // ── Roles not set yet ──────────────────────────────────────────────
        if (!exposures.length || !outcomes.length) {
            out.push({ level: 'info', text: 'Mark one variable as the ' +
                (!exposures.length ? 'exposure (the cause you are studying)' : '') +
                (!exposures.length && !outcomes.length ? ' and one as the ' : '') +
                (!outcomes.length ? 'outcome (the effect you are studying)' : '') +
                ' to get adjustment advice.' });
            return out;
        }

        var expV = g.getSources(), outV = g.getTargets();
        var descE = strictDescendants(g, expV);
        var descO = strictDescendants(g, outV);
        var ancE  = strictAncestors(g, expV);
        var ancO  = strictAncestors(g, outV);

        // ── Direction sanity ───────────────────────────────────────────────
        var reversed = exposures.filter(function (e) { return has(descO, e); });
        if (reversed.length) {
            out.push({ level: 'error', subject: list(reversed),
                text: ' is a consequence of ' + list(outcomes) + ' in this diagram, not a cause of it. ' +
                      'If you meant the opposite, the arrow between them is drawn the wrong way round.' });
        } else if (!exposures.some(function (e) { return outcomes.some(function (o) { return has(descE, o); }); })) {
            out.push({ level: 'warn',
                text: 'There is no directed path from ' + list(exposures) + ' to ' + list(outcomes) +
                      ', so as drawn your diagram says ' + list(exposures) + ' has no causal effect on ' +
                      list(outcomes) + '. Add the arrows describing how one leads to the other.' });
        }

        // ── Adjustment problems ────────────────────────────────────────────
        var kindEl = document.getElementById('causal_effect_kind');
        var kind = kindEl ? kindEl.value : 'adj_total';
        var wantDirect = (kind === 'adj_direct');

        adjusted.forEach(function (a) {
            if (has(latent, a)) {
                out.push({ level: 'error', subject: a,
                    text: ' is marked both unobserved and adjusted. You cannot control for a variable ' +
                          'you have not measured — untick one of the two.' });
                return;
            }

            var onCausalPath = has(descE, a) && has(ancO, a);
            if (onCausalPath && !wantDirect) {
                out.push({ level: 'warn', subject: a,
                    text: ' sits on a causal pathway from ' + list(exposures) + ' to ' + list(outcomes) +
                          ' (a mediator). Controlling for it removes part of the very effect you are ' +
                          'trying to measure. Leave it unadjusted for the total effect — or switch the ' +
                          'strategy above to "direct effect" if that is what you want.' });
                return;
            }
            if (onCausalPath) return;   // intended when estimating a direct effect

            if (has(descO, a)) {
                out.push({ level: 'warn', subject: a,
                    text: ' is a consequence of ' + list(outcomes) + '. Controlling for something the ' +
                          'outcome causes can create bias rather than remove it.' });
                return;
            }
            if (has(descE, a)) {
                out.push({ level: 'warn', subject: a,
                    text: ' is a consequence of ' + list(exposures) + '. Controlling for variables ' +
                          'affected by the exposure can bias the estimate — check whether you need it.' });
                return;
            }

            // Collider: a common effect of something on the exposure side and
            // something on the outcome side. Conditioning on it opens a path
            // between those two causes that was closed before.
            var parents = ids(g.getVertex(a).getParents());
            var side1 = parents.filter(function (p) { return has(ancE, p) || has(exposures, p); });
            var side2 = parents.filter(function (p) { return has(ancO, p) || has(outcomes, p); });
            var pair = null;
            side1.some(function (p1) {
                return side2.some(function (p2) { if (p1 !== p2) { pair = [p1, p2]; return true; } return false; });
            });
            if (pair) {
                out.push({ level: 'warn', subject: a,
                    text: ' is a common effect (a "collider") of ' + pair[0] + ' and ' + pair[1] +
                          '. Controlling for it induces an association between those two that is not ' +
                          'causal, which biases your estimate. Colliders should usually be left ' +
                          'unadjusted.' });
            }
        });

        // ── Sample selection ───────────────────────────────────────────────
        selected.forEach(function (s) {
            var fromE = has(descE, s) || has(exposures, s);
            var fromO = has(descO, s) || has(outcomes, s);
            if (fromE && fromO) {
                out.push({ level: 'warn', subject: s,
                    text: ' decides who is in your sample and is affected by both ' + list(exposures) +
                          ' and ' + list(outcomes) + '. Restricting the sample on a common effect of the ' +
                          'two creates a spurious association between them (selection bias) even if ' +
                          'there is no real effect — a classic cause of misleading results from ' +
                          'drop-out or opt-in samples.' });
            } else if (fromE || fromO) {
                out.push({ level: 'info', subject: s,
                    text: ' decides who is in your sample and is affected by ' +
                          (fromE ? list(exposures) : list(outcomes)) +
                          '. Check the adjustment advice below — selection can bias the estimate.' });
            }
        });

        // ── Unmeasured variables on the adjustment path ────────────────────
        var neededLatent = latent.filter(function (l) {
            return has(ancE, l) && has(ancO, l);
        });
        if (neededLatent.length) {
            out.push({ level: 'info', subject: list(neededLatent),
                text: (neededLatent.length === 1 ? ' is an unmeasured common cause' : ' are unmeasured common causes') +
                      ' of the exposure and the outcome. You cannot adjust for ' +
                      (neededLatent.length === 1 ? 'it' : 'them') + ', so the estimate is only as good ' +
                      'as your argument that the remaining controls are enough.' });
        }

        if (!out.length) out.push({ level: 'ok', text: 'No common problems found in this diagram.' });
        return out;
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    var ICON = { error: '✕', warn: '!', info: 'i', ok: '✓' };

    function render() {
        var host = document.getElementById('diagram_check');
        if (!host) return;
        var findings = analyse();

        host.replaceChildren();

        var ul = document.createElement('ul');
        ul.className = 'dcheck-list';
        findings.forEach(function (f) {
            var li = document.createElement('li');
            li.className = 'dcheck-item dcheck-' + f.level;

            var badge = document.createElement('span');
            badge.className = 'dcheck-badge';
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = ICON[f.level] || '·';
            li.appendChild(badge);

            var body = document.createElement('span');
            body.className = 'dcheck-text';
            if (f.subject) {
                var s = document.createElement('strong');
                s.textContent = f.subject;
                body.appendChild(s);
            }
            body.appendChild(document.createTextNode(f.text));
            li.appendChild(body);
            ul.appendChild(li);
        });
        host.appendChild(ul);

        // Badge the section header with the number of things needing attention.
        var count = findings.filter(function (f) { return f.level === 'error' || f.level === 'warn'; }).length;
        var hdr = document.getElementById('dcheck_count');
        if (hdr) {
            hdr.textContent = count ? String(count) : '';
            hdr.style.display = count ? '' : 'none';
        }
    }

    var _timer = null;
    function renderDebounced() {
        if (_timer) clearTimeout(_timer);
        _timer = setTimeout(function () { _timer = null; render(); }, 200);
    }

    window.DiagramCheck = { refresh: render, analyse: analyse };

    window.addEventListener('load', function () {
        if (window.DAGittyControl) DAGittyControl.observe('graphchange', renderDebounced);
        var kindEl = document.getElementById('causal_effect_kind');
        if (kindEl) kindEl.addEventListener('change', renderDebounced);
        setTimeout(render, 130);
    });

})();
