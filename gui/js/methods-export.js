/* DAGitty — Methods & Assumptions Export
 *
 * Turns the current diagram into a plain-language statement of the causal
 * assumptions it encodes, ready to paste into a paper's methods / limitations
 * section. Augments the GUI without modifying main.js.
 *
 * The whole point (per the project's accessibility goal): make the
 * *untestable assumptions* required to read an adjusted association as causal
 * explicit, so authors can state them honestly.
 */

(function () {
    'use strict';

    function ids(verts) { return _.pluck(verts, 'id').sort(); }

    function list(arr) {
        // "A", "A and B", "A, B and C"
        if (arr.length === 0) return '';
        if (arr.length === 1) return arr[0];
        if (arr.length === 2) return arr[0] + ' and ' + arr[1];
        return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
    }

    function setBraces(set) { return '{' + set.join(', ') + '}'; }

    /** Build the plain-language methods statement for the current graph. */
    function generate() {
        var g = (window.Model && Model.dag) ? Model.dag : null;
        if (!g) return 'No model loaded.';

        var exposures = ids(g.getSources());
        var outcomes  = ids(g.getTargets());
        var adjusted  = ids(g.getAdjustedNodes());
        var latent    = ids(g.getLatentNodes());
        var allIds    = ids(g.getVertices());
        var covariates = _.difference(allIds, exposures, outcomes);

        if (exposures.length === 0 || outcomes.length === 0) {
            return 'Set at least one exposure (cause) and one outcome (effect) to generate a ' +
                   'methods statement. Click a variable and tick "exposure" or "outcome".';
        }

        var cyclic = GraphAnalyzer.containsCycle(g);
        var lines = [];

        // 1. Model overview
        var roleParts = [];
        roleParts.push(list(exposures) + ' as the exposure' + (exposures.length > 1 ? 's (causes)' : ' (cause)'));
        roleParts.push(list(outcomes) + ' as the outcome' + (outcomes.length > 1 ? 's (effects)' : ' (effect)'));
        var overview = 'We represented our causal assumptions as a directed acyclic graph (DAG) over ' +
            allIds.length + ' variable' + (allIds.length !== 1 ? 's' : '') + ', specifying ' +
            list(roleParts) + '.';
        if (covariates.length) {
            overview += ' The remaining variable' + (covariates.length !== 1 ? 's' : '') + ' (' +
                list(covariates) + ') ' + (covariates.length !== 1 ? 'were' : 'was') +
                ' included as ' + (covariates.length !== 1 ? 'covariates' : 'a covariate') + '.';
        }
        if (latent.length) {
            overview += ' ' + list(latent) + ' ' + (latent.length !== 1 ? 'were' : 'was') +
                ' modelled as unobserved (latent).';
        }
        lines.push(overview);

        // 2. Assumed relationships
        var directed = [], bidirected = [];
        g.getEdges().forEach(function (e) {
            if (e.directed === Graph.Edgetype.Directed) directed.push(e.v1.id + ' → ' + e.v2.id);
            else if (e.directed === Graph.Edgetype.Bidirected) bidirected.push(e.v1.id + ' and ' + e.v2.id);
        });
        if (directed.length) {
            lines.push('The diagram assumes the following direct causal relationships (an arrow X → Y means ' +
                'X is assumed to directly affect Y): ' + directed.join('; ') + '.');
        }
        if (bidirected.length) {
            lines.push('The following pairs are assumed to share one or more unmeasured common causes: ' +
                bidirected.join('; ') + '.');
        }

        // 3. Identification of the total effect
        if (cyclic) {
            lines.push('NOTE: the diagram currently contains a cycle (' + cyclic + '), so a total ' +
                'effect cannot be identified until it is made acyclic.');
        } else {
            var isSuff = GraphAnalyzer.isAdjustmentSet(g);
            var msas = GraphAnalyzer.listMsasTotalEffect(g).map(function (s) { return ids(s); });
            var noAdjNeeded = msas.length === 1 && msas[0].length === 0;
            var expOut = 'the total effect of ' + list(exposures) + ' on ' + list(outcomes);

            if (adjusted.length === 0) {
                if (isSuff) {
                    lines.push('Under this DAG no adjustment is required to estimate ' + expOut +
                        ': there are no open confounding (back-door) paths.');
                } else {
                    lines.push('Under this DAG ' + expOut + ' is confounded: a naive unadjusted comparison ' +
                        'would be biased. ' + msaSentence(msas));
                }
            } else {
                if (isSuff) {
                    lines.push('To estimate ' + expOut + ' we adjusted for ' + setBraces(adjusted) +
                        '. Under the DAG this set is sufficient to block all confounding (back-door) paths. ' +
                        msaSentence(msas));
                } else {
                    lines.push('WARNING: the chosen adjustment set ' + setBraces(adjusted) + ' is NOT sufficient ' +
                        'to identify ' + expOut + ' under this DAG — confounding paths remain open. ' +
                        msaSentence(msas));
                }
            }
        }

        // 4. Testable implications
        if (!cyclic) {
            var imps = GraphAnalyzer.listMinimalImplications(g);
            var count = 0;
            imps.forEach(function (t) { count += t[2].length; });
            if (count > 0) {
                var first = imps[0];
                var ex = first[0] + ' ⊥ ' + first[1] +
                    (first[2][0].length ? ' | ' + ids(first[2][0]).join(', ') : '');
                lines.push('The model implies ' + count + ' testable conditional independenc' +
                    (count !== 1 ? 'ies' : 'y') + ' (for example, ' + ex + '). ' +
                    'These can be checked against the data to partially assess whether the assumed structure is consistent with what was observed.');
            }
        }

        // 5. The untestable assumptions (the crux)
        var assumptions = [
            'the diagram is correct and complete — every common cause of the variables shown is itself included, ' +
                'and no relevant variable or arrow has been omitted' +
                (latent.length ? ' (beyond the unobserved variables explicitly modelled)' : ' (no unmeasured confounding)'),
            'the direction of every arrow reflects the true causal order',
            'the variables are measured without error that would distort these relationships, and the statistical model ' +
                'used to adjust for the variables above is correctly specified'
        ];
        lines.push('Interpreting the resulting association as a causal effect rests on the following assumptions, ' +
            'which cannot be verified from the data alone and depend on subject-matter knowledge: (i) ' +
            assumptions[0] + '; (ii) ' + assumptions[1] + '; (iii) ' + assumptions[2] + '.');

        lines.push('Diagram analysed with DAGitty. The model can be reproduced from its code (see the "Model code" panel).');

        return lines.join('\n\n');
    }

    function msaSentence(msas) {
        if (!msas.length) {
            return 'No sufficient adjustment set exists for this exposure–outcome pair under the current diagram, ' +
                'so the effect is not identifiable by covariate adjustment alone.';
        }
        if (msas.length === 1 && msas[0].length === 0) {
            return 'No adjustment is necessary (the minimal sufficient adjustment set is empty).';
        }
        var sets = msas.map(setBraces);
        return 'Minimal sufficient adjustment set' + (sets.length !== 1 ? 's are ' : ' is ') +
            list(sets) + '.';
    }

    function refresh() {
        var ta = document.getElementById('methods_text');
        if (!ta) return;
        ta.value = generate();
    }

    function copyText() {
        var ta = document.getElementById('methods_text');
        if (!ta) return;
        var btn = document.getElementById('methods_copy_btn');
        var done = function () {
            if (!btn) return;
            var old = btn.textContent;
            btn.textContent = 'Copied ✓';
            btn.classList.add('copied');
            setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(ta.value).then(done, function () { selectFallback(ta); done(); });
        } else {
            selectFallback(ta);
            try { document.execCommand('copy'); } catch (e) {}
            done();
        }
    }

    function selectFallback(ta) { ta.focus(); ta.select(); }

    window.MethodsExport = { refresh: refresh, copy: copyText, generate: generate };

    window.addEventListener('load', function () {
        if (window.DAGittyControl) {
            DAGittyControl.observe('graphchange', function () { refresh(); });
        }
        // initial fill (after initialize() has built Model.dag)
        setTimeout(refresh, 120);
    });

})();
