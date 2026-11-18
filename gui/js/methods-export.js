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

    // Statistical evidence belongs to the causal model, not to its drawing.
    // Keep insertion order, coordinates, bounding boxes and arrow curvature out
    // of this key; retain roles because latent/selection status changes tests.
    window.AnalysisModelKey = function (g) {
        if (!g) return null;
        var roles = ['getSources', 'getTargets', 'getAdjustedNodes', 'getLatentNodes', 'getSelectedNodes']
            .map(function (getter) { return g[getter] ? ids(g[getter]()) : []; });
        var edges = g.getEdges().map(function (e) {
            var ends = [e.v1.id, e.v2.id];
            if (Graph.Edgetype.Symmetric[e.directed]) ends.sort();
            return [ends[0], ends[1], e.directed];
        });
        edges.sort(function (a, b) {
            a = JSON.stringify(a); b = JSON.stringify(b);
            return a < b ? -1 : a > b ? 1 : 0;
        });
        return JSON.stringify([g.getType(), ids(g.getVertices()), roles, edges]);
    };

    var IMPLICATION_CAP = 200;

    // Sentence(s) describing the outcome of testing the implications against
    // data, set by LocalTests (local-tests.js) and cleared when the model
    // changes in a way that invalidates them. Null → the placeholder is shown.
    var _localTestResults = null;
    var _localTestKey = null;   // causal model (excluding layout) the results belong to

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
        // Exports can call generate() before the debounced refresh has run.
        // Never attach results from a different diagram to a new statement.
        if (_localTestResults && window.AnalysisModelKey(g) !== _localTestKey) {
            _localTestResults = null; _localTestKey = null;
        }

        var exposures = ids(g.getSources());
        var outcomes  = ids(g.getTargets());
        var adjusted  = ids(g.getAdjustedNodes());
        var latent    = ids(g.getLatentNodes());
        var selected  = ids(g.getSelectedNodes ? g.getSelectedNodes() : []);
        var invalidControls = window.AdjustmentSets && AdjustmentSets.invalidControls
            ? ids(AdjustmentSets.invalidControls(g))
            : adjusted.filter(function (id) {
                return exposures.indexOf(id) !== -1 || outcomes.indexOf(id) !== -1 ||
                    latent.indexOf(id) !== -1 || selected.indexOf(id) !== -1;
            });
        var allIds    = ids(g.getVertices());
        var covariates = _.difference(allIds, exposures, outcomes);

        if (exposures.length === 0 || outcomes.length === 0) {
            return 'Set at least one exposure (cause) and one outcome (effect) to generate a ' +
                   'methods statement. Click a variable and tick "exposure" or "outcome".';
        }

        // containsCycle() joins the path with the HTML entity "&rarr;" for the
        // summary panel's innerHTML; this text lands in a textarea, so decode it.
        var cyclic = GraphAnalyzer.containsCycle(g);
        if (cyclic) cyclic = String(cyclic).replace(/&rarr;/g, '→');
        var lines = [];

        // 1. Model overview
        var roleParts = [];
        roleParts.push(list(exposures) + ' as the exposure' + (exposures.length > 1 ? 's (causes)' : ' (cause)'));
        roleParts.push(list(outcomes) + ' as the outcome' + (outcomes.length > 1 ? 's (effects)' : ' (effect)'));
        var graphType = g.getType ? g.getType() : 'dag';
        var partial = graphType === 'pdag';
        var overview = 'We represented our causal assumptions as a ' +
            (partial ? 'partially directed acyclic graph (PDAG)' : graphType === 'dag'
                ? 'directed acyclic graph (DAG)' : 'causal graph (' + graphType.toUpperCase() + ')') + ' over ' +
            allIds.length + ' variable' + (allIds.length !== 1 ? 's' : '') + ', specifying ' +
            list(roleParts) + '.';
        if (covariates.length) {
            // Deliberately NOT "covariates": in a DAG some variables (e.g. mediators,
            // colliders) should be left OUT of the statistical model, so calling them
            // covariates would be misleading.
            overview += covariates.length !== 1
                ? ' Other variables in the system included ' + list(covariates) + '.'
                : ' Another variable in the system was ' + covariates[0] + '.';
        }
        if (latent.length) {
            overview += ' ' + list(latent) + ' ' + (latent.length !== 1 ? 'were' : 'was') +
                ' modelled as unobserved (latent).';
        }
        if (partial) overview += ' Undirected edges represent unresolved causal direction; these relationships ' +
            'require subject-matter review before presenting a fully specified causal model.';
        lines.push(overview);

        // 2. Assumed relationships. The directed arrows are shown in the diagram
        //    itself, so restating them in prose would be redundant; we only spell
        //    out unmeasured common causes, which are easy to overlook in a figure.
        var bidirected = [];
        g.getEdges().forEach(function (e) {
            if (e.directed === Graph.Edgetype.Bidirected) bidirected.push(e.v1.id + ' and ' + e.v2.id);
        });
        if (bidirected.length) {
            lines.push('The following pairs are assumed to share one or more unmeasured common causes: ' +
                bidirected.join('; ') + '.');
        }

        // 3. Identification of the target effect (reflects the chosen estimand)
        var kindEl = (typeof document !== 'undefined') ? document.getElementById('causal_effect_kind') : null;
        var kind = kindEl ? kindEl.value : 'adj_total';
        var expOutBase = list(exposures) + ' on ' + list(outcomes);
        var usingIV = (kind === 'instrument');
        var unsupported = kind === 'adj_total' && ['dag', 'pdag', 'mag', 'pag'].indexOf(graphType) === -1
            ? 'DAGitty supports total-effect adjustment analysis for DAGs, PDAGs, MAGs and PAGs only.'
            : kind === 'adj_direct' && (selected.length || graphType !== 'dag')
            ? 'DAGitty does not support direct-effect adjustment analysis for this graph type or with selection nodes.'
            : kind === 'adj_causalodds' && (graphType !== 'dag' || exposures.length !== 1 || outcomes.length !== 1 || selected.length !== 1)
                ? 'The causal-odds-ratio analysis requires a DAG with exactly one exposure, one outcome and one selection node.'
                : null;
        var usingAdjustment = !cyclic && !usingIV && !unsupported;

        if (cyclic) {
            lines.push('NOTE: the diagram currently contains a cycle (' + cyclic + '), so a causal ' +
                'effect cannot be identified until the diagram is made acyclic.');
        } else if (unsupported) {
            lines.push('NOTE: ' + unsupported + ' No identification claim is made for the chosen strategy.');
        } else if (usingIV) {
            lines.push('We estimated the effect of ' + expOutBase + ' using an instrumental-variable (IV) ' +
                'strategy rather than covariate adjustment. This identifies the effect only if a valid instrument ' +
                'is available — a variable that (i) is associated with ' + list(exposures) + ' (relevance), ' +
                '(ii) affects ' + list(outcomes) + ' only through ' + list(exposures) + ' (the exclusion ' +
                'restriction), and (iii) shares no unmeasured common cause with ' + list(outcomes) +
                ' (instrument exogeneity). The exclusion restriction and exogeneity are encoded in the diagram ' +
                'but cannot be verified from data alone. The chosen instrument, estimator and target effect must ' +
                'also be specified: additional assumptions such as linearity or homogeneous effects, or monotonicity ' +
                'for a local average treatment effect, depend on that choice.');
        } else if (invalidControls.length) {
            var repair = '';
            if (kind === 'adj_causalodds') {
                repair = 'Minimal adjustment sets for this selection-specific criterion are not enumerated by this interface.';
            } else {
                var repairKind = kind === 'adj_direct' ? 'direct' : 'total';
                var repairSets;
                if (window.AdjustmentSets) repairSets = AdjustmentSets.minimal(g, repairKind);
                else {
                    var repairGraph = g.clone();
                    repairGraph.getAdjustedNodes().slice().forEach(function (v) { repairGraph.removeAdjustedNode(v); });
                    repairSets = (repairKind === 'direct' ? GraphAnalyzer.listMsasDirectEffect(repairGraph)
                        : GraphAnalyzer.listMsasTotalEffect(repairGraph)).map(function (set) { return ids(set); });
                }
                repair = !repairSets ? 'Review the adjustment advice in the full editor.'
                    : !repairSets.length ? 'No set of measured variables identifies this effect by adjustment under the current diagram.'
                    : repairSets.length === 1 && repairSets[0].length === 0
                        ? 'Under this diagram the effect could be estimated without ordinary control variables.'
                        : msaSentence(repairSets);
            }
            lines.push('WARNING: the proposed adjustment set ' + setBraces(adjusted) + ' includes conflicting Adjusted marks on ' +
                list(invalidControls) + '. Exposure, outcome, unobserved and selection variables cannot be ordinary measured controls. ' +
                'Clear the conflicting Adjusted marks before interpreting this analysis. ' + repair);
        } else if (kind === 'adj_causalodds') {
            var oddsSufficient = GraphAnalyzer.isAdjustmentSetCausalOddsRatio(g);
            lines.push('We targeted the causal odds ratio of ' + expOutBase + ' in a sample selected on ' +
                setBraces(selected) + ', with the proposed adjustment set ' + setBraces(adjusted) + '. ' +
                (oddsSufficient ? 'This set passes DAGitty\'s causal-odds-ratio criterion under the diagram.'
                    : 'WARNING: this set does NOT pass DAGitty\'s causal-odds-ratio criterion under the diagram; ' +
                      'the chosen analysis is not justified by that criterion.') +
                ' Minimal adjustment sets for this selection-specific criterion are not enumerated by this interface.');
        } else {
            var isDirect = (kind === 'adj_direct');
            var effectLabel = isDirect ? 'direct effect'
                            : (kind === 'adj_causalodds') ? 'total effect (reported as a causal odds ratio)'
                            : 'total effect';
            var expOut = 'the ' + effectLabel + ' of ' + expOutBase;

            // The minimal sufficient sets, IGNORING what the user has ticked as
            // adjusted. listMsas*Effect(g) would instead treat those nodes as
            // mandatory — and return nothing at all if one of them (a mediator,
            // say) must not be adjusted for — which this statement used to
            // report as "the effect is not identifiable". It is; the chosen set
            // is just wrong. AdjustmentSets (ui-enhancements.js) does the
            // unconstrained computation; fall back to the constrained call if
            // it is unavailable.
            var msas = (window.AdjustmentSets && AdjustmentSets.minimal(g, isDirect ? 'direct' : 'total')) ||
                (isDirect ? GraphAnalyzer.listMsasDirectEffect(g)
                          : GraphAnalyzer.listMsasTotalEffect(g)).map(function (s) { return ids(s); });
            var noSetExists = msas.length === 0;
            var noAdjNeeded = msas.length === 1 && msas[0].length === 0;
            var isSuff = isDirect ? GraphAnalyzer.isAdjustmentSetDirectEffect(g) : GraphAnalyzer.isAdjustmentSet(g);
            var isMinimal = !!(window.AdjustmentSets && AdjustmentSets.isOneOf(g, msas));
            var mediatorNote = isDirect
                ? ' Note that adjustment sets for the direct effect differ from those for the total effect, ' +
                  'because variables on the indirect (mediated) paths must be held fixed.'
                : '';
            var pathsWord = isDirect ? 'biasing paths' : 'confounding (back-door) paths';

            if (adjusted.length === 0) {
                if (noSetExists) {
                    lines.push('Under this diagram ' + expOut + ' is not identifiable by covariate adjustment alone: ' +
                        'no measured-variable set meets the adjustment criterion' +
                        (selected.length ? ', including its requirements for the selection mechanism' : '') + '.' + mediatorNote);
                } else if (noAdjNeeded) {
                    lines.push('Under this diagram no adjustment is required to estimate ' + expOut +
                        ': there are no open ' + pathsWord + '.' + mediatorNote);
                } else {
                    lines.push('Under this diagram ' + expOut + ' is ' + (isDirect ? 'not identified without adjustment'
                        : 'confounded') + ': a naive unadjusted comparison would be biased. ' +
                        msaSentence(msas) + mediatorNote);
                }
            } else if (isSuff) {
                var extra = '';
                if (!isMinimal && noAdjNeeded) {
                    extra = ' No adjustment would strictly have been necessary under this diagram.';
                } else if (!isMinimal && !noSetExists) {
                    extra = ' A smaller set would also suffice: ' + msaSentence(msas).replace(/^Minimal/, 'the minimal');
                }
                lines.push('To estimate ' + expOut + ' we adjusted for ' + setBraces(adjusted) +
                    '. Under the diagram this set meets the adjustment criterion for the chosen effect.' + extra + mediatorNote);
            } else {
                // Say what is wrong with the chosen set as precisely as we can:
                // for the total effect, adjusting for anything on (or downstream
                // of) a causal path from exposure to outcome is never allowed.
                var forbidden = !isDirect && GraphAnalyzer.violatesAdjustmentCriterion(g);
                var why = forbidden
                    ? ' — it includes a variable that lies on, or is affected by, the causal pathway from ' +
                      list(exposures) + ' to ' + list(outcomes) + ', which must not be adjusted for when ' +
                      'estimating a total effect'
                    : selected.length ? ' — a biasing path remains open or the selection mechanism fails the criterion'
                    : ' — ' + pathsWord + ' remain open';
                var remedy = noSetExists
                    ? 'No set of measured variables identifies this effect by adjustment under the current diagram.'
                    : noAdjNeeded
                        ? 'Under this diagram the effect could be estimated without any adjustment.'
                        : msaSentence(msas);
                lines.push('WARNING: the chosen adjustment set ' + setBraces(adjusted) + ' is NOT sufficient to ' +
                    'identify ' + expOut + ' under this diagram' + why + '. ' + remedy + mediatorNote);
            }
        }

        // 3b. Sample selection
        if (selected.length) {
            lines.push('The analysis is conditioned on sample-selection variable' +
                (selected.length !== 1 ? 's' : '') + ' ' + setBraces(selected) +
                ', which determine' + (selected.length === 1 ? 's' : '') + ' who is included in the sample. ' +
                'Conditioning on a common effect (collider) of, or a variable affected by, the exposure or outcome ' +
                'can itself open a biasing path; we assume the diagram correctly represents the selection mechanism ' +
                'and assess whether the proposed adjustment addresses that bias. A selection node does not ' +
                'by itself correct selection bias; an insufficient adjustment set remains insufficient.');
        }

        // 4. Testable implications. Enumerating every minimal implication is the
        //    most expensive analysis on the page and this runs on every edit, so
        //    stop counting at IMPLICATION_CAP and say "at least".
        if (!cyclic) {
            var imps = GraphAnalyzer.listMinimalImplications(g, IMPLICATION_CAP);
            var count = 0;
            imps.forEach(function (t) { count += t[2].length; });
            if (count > 0) {
                var first = imps[0];
                var ex = first[0] + ' ⊥ ' + first[1] +
                    (first[2][0].length ? ' | ' + ids(first[2][0]).join(', ') : '');
                var countText = (count >= IMPLICATION_CAP ? 'at least ' : '') + count;
                var s = 'The model implies ' + countText + ' testable conditional independenc' +
                    (count !== 1 ? 'ies' : 'y') + ' (for example, ' + ex + '). ';
                if (_localTestResults) {
                    // Filled in by the in-browser "Test against my data" tool.
                    s += _localTestResults;
                } else {
                    s += '[REPORT CHECKS HERE: state whether these implications were tested, the test used, ' +
                        'the sample size, the estimates and confidence intervals, and the raw and multiplicity-adjusted ' +
                        'p-values; explain any implications not tested. Use localTests() from the dagitty R package ' +
                        'or Testable implications → Test against my data. Failure to reject an implication does not ' +
                        'establish independence or validate the causal directions.]';
                }
                lines.push(s);
            }
        }

        // 5. The untestable assumptions (the crux)
        var assumptions = [];
        assumptions.push('adequate causal structure — the diagram represents the relevant common causes ' +
            '(including any explicitly modelled unobserved causes), and no omitted variable or arrow ' +
            'invalidates the proposed identification strategy; drawing an unobserved cause does not remove its confounding');
        assumptions.push('the direction of every arrow reflects the true causal order');
        if (usingAdjustment) {
            assumptions.push('positivity — every level of the exposure has a non-zero probability of occurring ' +
                'within each stratum of the adjustment variables, so the comparison is supported by data throughout');
        }
        assumptions.push('consistency (a well-defined intervention) — the exposure corresponds to a ' +
            'sufficiently well-specified intervention that the outcome observed at a given exposure level equals ' +
            'the outcome that would occur if it were set to that level');
        assumptions.push('no interference between study units, unless interference is explicitly represented ' +
            'and accounted for in the target effect and analysis');
        assumptions.push('no measurement error or model misspecification that would distort these relationships — ' +
            'the variables are measured accurately enough, and the statistical model used' +
            (usingIV ? ' for estimation' : ' to adjust for the variables above') + ' is correctly specified');

        var roman = ['(i)', '(ii)', '(iii)', '(iv)', '(v)', '(vi)'];
        var enumerated = assumptions.map(function (a, i) { return roman[i] + ' ' + a; }).join('; ');
        lines.push('Interpreting the resulting association as a causal effect rests on the following assumptions, ' +
            'which cannot be verified from the data alone and depend on subject-matter knowledge: ' + enumerated + '.');

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
        // Results were computed for one particular diagram; drop them silently
        // if the diagram has since changed (they would describe a different model).
        if (_localTestResults && window.Model && Model.dag && window.AnalysisModelKey(Model.dag) !== _localTestKey) {
            _localTestResults = null; _localTestKey = null;
        }
        ta.value = generate();
    }

    /** Called by LocalTests with a ready-to-paste sentence, or null to clear. */
    function setLocalTestResults(text) {
        _localTestResults = text || null;
        _localTestKey = (text && window.Model && Model.dag) ? window.AnalysisModelKey(Model.dag) : null;
        refresh();
    }

    function copyText() {
        // A strategy change or recent graph edit can precede the debounced
        // preview refresh. Always copy a statement for the current model.
        refresh();
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

    // The methods statement is the heaviest analysis on the page (it enumerates
    // all minimal implications and adjustment sets). Debounce it so a burst of
    // edits only recomputes once the user pauses, keeping editing responsive.
    var _refreshTimer = null;
    function refreshDebounced() {
        if (_refreshTimer) clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(function () { _refreshTimer = null; refresh(); }, 200);
    }

    window.MethodsExport = { refresh: refresh, copy: copyText, generate: generate,
                             setLocalTestResults: setLocalTestResults };

    window.addEventListener('load', function () {
        if (window.DAGittyControl) {
            DAGittyControl.observe('graphchange', refreshDebounced);
        }
        var kindEl = document.getElementById('causal_effect_kind');
        if (kindEl) kindEl.addEventListener('change', refresh);
        // initial fill (after initialize() has built Model.dag)
        setTimeout(refresh, 120);
    });

})();
