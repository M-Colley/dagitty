/* DAGitty — One-file report export
 *
 * Everything the tool knows about the current diagram in a single,
 * self-contained HTML file suitable as supplementary material: the figure
 * (inline SVG), the variables and their roles, the estimand and adjustment
 * verdict with the minimal sufficient sets, the Diagram-check findings, every
 * path between exposure and outcome, the testable implications, the results of
 * testing them against data (if that was done), the plain-language methods
 * statement, the model code and R code to reproduce the analysis.
 *
 * The same content is embedded as machine-readable JSON in the file (and can
 * be downloaded on its own), so a script can read the report back.
 */

(function () {
    'use strict';

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function ids(vs) { return _.pluck(vs || [], 'id').sort(); }

    var KIND_LABEL = {
        adj_total: 'total effect (covariate adjustment)',
        adj_direct: 'direct effect (covariate adjustment)',
        adj_causalodds: 'causal odds ratio (covariate adjustment)',
        instrument: 'instrumental variable'
    };

    /** Gather every analysis result into one plain object. */
    function collect() {
        var g = (window.Model && Model.dag) ? Model.dag : null;
        if (!g) return null;
        var kindEl = document.getElementById('causal_effect_kind');
        var kind = kindEl ? kindEl.value : 'adj_total';
        var msasKind = kind === 'adj_direct' ? 'direct' : 'total';
        var cyclic = GraphAnalyzer.containsCycle(g);
        if (cyclic) cyclic = String(cyclic).replace(/&rarr;/g, '→');

        var exposure = ids(g.getSources()), outcome = ids(g.getTargets()), adjusted = ids(g.getAdjustedNodes()),
            selected = ids(g.getSelectedNodes()), latent = ids(g.getLatentNodes());
        var all = ids(g.getVertices());
        var other = _.difference(all, exposure, outcome, adjusted, selected, latent);

        var adjustment = null;
        if (exposure.length && outcome.length && !cyclic && kind !== 'instrument') {
            var sufficient = null;
            try {
                sufficient = msasKind === 'direct' ? GraphAnalyzer.isAdjustmentSetDirectEffect(g) : GraphAnalyzer.isAdjustmentSet(g);
            } catch (e) { sufficient = null; }
            adjustment = {
                chosen: adjusted,
                sufficient: sufficient,
                minimalSets: window.AdjustmentSets ? AdjustmentSets.minimal(g, msasKind) : null
            };
        }

        var implications = [], implCapped = false;
        if (!cyclic) {
            var raw = GraphAnalyzer.listMinimalImplications(g, 500), n = 0;
            raw.forEach(function (t) {
                t[2].forEach(function (s) { implications.push({ x: t[0], y: t[1], z: ids(s) }); n++; });
            });
            implCapped = n >= 500;
        }

        var diagramCheck = window.DiagramCheck ? DiagramCheck.analyse().map(function (f) {
            return { level: f.level, text: (f.subject ? f.subject : '') + f.text };
        }) : [];

        var paths = null;
        if (window.Paths) {
            var pr = Paths.analyse(g, msasKind);
            if (pr && !pr.cyclic) {
                paths = {
                    truncated: pr.truncated,
                    list: pr.paths.map(function (p) {
                        return { path: p.text, causal: p.causal, open: p.open, explanation: p.explanation };
                    })
                };
            }
        }

        var modelCode = g.toString();
        var localTests = null;
        if (window.LocalTests && LocalTests.last && LocalTests.last.modelCode === modelCode) {
            var lt = LocalTests.last;
            localTests = {
                data: lt.dataLabel || null,
                summary: lt.summary,
                sentence: LocalTests.methodsSentence(lt),
                tests: lt.tests.map(function (t) {
                    return t.skipped
                        ? { implication: LocalTests.implText(t.imp), skipped: t.skipped }
                        : { implication: LocalTests.implText(t.imp), estimate: t.estimate, ciLow: t.lo, ciHigh: t.hi,
                            p: t.p, pHolm: t.pHolm, n: t.n, violated: t.violated };
                })
            };
        }

        var rstr = modelCode.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return {
            generatedAt: new Date().toISOString(),
            generator: 'DAGitty (accessibility fork), ' + (typeof location !== 'undefined' ? location.origin + location.pathname : ''),
            modelCode: modelCode,
            cyclic: cyclic || null,
            roles: { exposure: exposure, outcome: outcome, adjusted: adjusted, selected: selected, latent: latent, other: other },
            estimand: { key: kind, label: KIND_LABEL[kind] || kind },
            adjustment: adjustment,
            diagramCheck: diagramCheck,
            paths: paths,
            implications: { capped: implCapped, list: implications },
            localTests: localTests,
            methodsStatement: window.MethodsExport ? MethodsExport.generate() : null,
            rCode: 'library(dagitty)\ng <- dagitty(\'' + rstr + '\')\nplot(g)\nadjustmentSets(g)\nimpliedConditionalIndependencies(g)\n# localTests(g, data = your_data)'
        };
    }

    // ── HTML rendering ────────────────────────────────────────────────────

    function setText(sets) {
        if (!sets) return 'not computed';
        if (!sets.length) return 'none — the effect is not identifiable by adjustment';
        return sets.map(function (s) { return '{' + (s.length ? s.join(', ') : '∅') + '}'; }).join(', ');
    }

    function roleRow(label, arr) {
        return '<tr><th scope="row">' + esc(label) + '</th><td>' + (arr.length ? esc(arr.join(', ')) : '<em>none</em>') + '</td></tr>';
    }

    function buildHTML(d, svgMarkup) {
        var h = [];
        var when = new Date(d.generatedAt);
        h.push('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">');
        h.push('<title>Causal diagram report — ' + esc(when.toISOString().slice(0, 10)) + '</title>');
        h.push('<style>' +
            'body{font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;max-width:900px;margin:2rem auto;padding:0 1.2rem}' +
            'h1{font-size:1.6rem;margin:.2rem 0 .1rem}h2{font-size:1.15rem;margin:2rem 0 .5rem;border-bottom:1px solid #e5e7eb;padding-bottom:.25rem}' +
            '.meta{color:#6b7280;font-size:.9rem}figure{margin:1rem 0;text-align:center}figure svg{max-width:100%;height:auto}' +
            'table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{border:1px solid #e5e7eb;padding:.35rem .55rem;text-align:left;vertical-align:top}' +
            'th{background:#f9fafb}tbody th{font-weight:600}code,pre{font-family:SFMono-Regular,Consolas,Menlo,monospace;font-size:.86em}' +
            'pre{background:#f3f4f6;padding:.8rem;border-radius:6px;overflow:auto;white-space:pre-wrap}' +
            '.ok{color:#047857}.bad{color:#b91c1c;font-weight:600}.warn{color:#b45309}.muted{color:#6b7280}' +
            '.finding{margin:.3rem 0;padding-left:1.4rem;position:relative}.finding::before{position:absolute;left:0;font-weight:700}' +
            '.finding.error::before{content:"✕";color:#b91c1c}.finding.warn::before{content:"!";color:#b45309}' +
            '.finding.info::before{content:"i";color:#2563eb}.finding.ok::before{content:"✓";color:#047857}' +
            '.path{font-family:SFMono-Regular,Consolas,Menlo,monospace}.small{font-size:.86rem}' +
            '@media print{body{margin:0;max-width:none}h2{break-after:avoid}table{break-inside:avoid}}' +
            '</style></head><body>');
        h.push('<h1>Causal diagram report</h1>');
        h.push('<p class="meta">Generated ' + esc(when.toLocaleString()) + ' with ' + esc(d.generator) +
            '. Everything below is derived from the diagram; the machine-readable version is embedded at the end of this file.</p>');

        if (svgMarkup) h.push('<figure>' + svgMarkup + '<figcaption class="muted small">Boxes: conditioned on (adjusted / selection). Dashed: unobserved.</figcaption></figure>');

        h.push('<h2>Variables</h2><table><tbody>' +
            roleRow('Exposure (cause)', d.roles.exposure) + roleRow('Outcome (effect)', d.roles.outcome) +
            roleRow('Adjusted (controlled for)', d.roles.adjusted) + roleRow('Sample selection', d.roles.selected) +
            roleRow('Unobserved (latent)', d.roles.latent) + roleRow('Other', d.roles.other) + '</tbody></table>');

        h.push('<h2>Identification</h2>');
        if (d.cyclic) {
            h.push('<p class="bad">The diagram contains a cycle (' + esc(d.cyclic) + '); no effect can be identified until it is removed.</p>');
        } else if (!d.roles.exposure.length || !d.roles.outcome.length) {
            h.push('<p class="muted">No exposure and outcome set — nothing to identify.</p>');
        } else {
            h.push('<p>Target: <strong>' + esc(d.estimand.label) + '</strong>.</p>');
            if (d.adjustment) {
                var a = d.adjustment;
                h.push('<table><tbody>' +
                    '<tr><th scope="row">Adjustment set chosen</th><td>' + (a.chosen.length ? '{' + esc(a.chosen.join(', ')) + '}' : '∅ (none)') + '</td></tr>' +
                    '<tr><th scope="row">Sufficient?</th><td>' + (a.sufficient === null ? 'not computed' : a.sufficient
                        ? '<span class="ok">Yes — blocks every biasing path under this diagram</span>'
                        : '<span class="bad">No — a biasing path remains open (or is opened) under this diagram</span>') + '</td></tr>' +
                    '<tr><th scope="row">Minimal sufficient sets</th><td>' + esc(setText(a.minimalSets)) + '</td></tr>' +
                    '</tbody></table>');
            }
        }

        h.push('<h2>Diagram check</h2>');
        if (!d.diagramCheck.length) h.push('<p class="muted">No findings.</p>');
        else d.diagramCheck.forEach(function (f) { h.push('<p class="finding ' + esc(f.level) + '">' + esc(f.text) + '</p>'); });

        if (d.paths) {
            h.push('<h2>Paths between exposure and outcome</h2>');
            if (!d.paths.list.length) h.push('<p class="muted">None.</p>');
            else {
                h.push('<table><thead><tr><th>Path</th><th>Kind</th><th>Status</th><th>Why</th></tr></thead><tbody>');
                d.paths.list.forEach(function (p) {
                    h.push('<tr><td class="path">' + esc(p.path) + '</td><td>' + (p.causal ? 'causal' : 'biasing') + '</td><td class="' +
                        (p.open ? (p.causal ? 'ok' : 'bad') : (p.causal ? 'warn' : 'ok')) + '">' + (p.open ? 'open' : 'blocked') +
                        '</td><td class="small">' + esc(p.explanation) + '</td></tr>');
                });
                h.push('</tbody></table>');
                if (d.paths.truncated) h.push('<p class="muted small">Only the first paths are listed.</p>');
            }
        }

        h.push('<h2>Testable implications</h2>');
        if (!d.implications.list.length) h.push('<p class="muted">The diagram implies no testable conditional independencies (or they involve unobserved variables).</p>');
        else {
            h.push('<p class="small muted">' + (d.implications.capped ? 'At least ' : '') + d.implications.list.length +
                ' conditional independencies. Each should hold in data generated by this diagram.</p><ul class="small">');
            d.implications.list.forEach(function (i) {
                h.push('<li class="path">' + esc(i.x) + ' ⊥ ' + esc(i.y) + (i.z.length ? ' | ' + esc(i.z.join(', ')) : '') + '</li>');
            });
            h.push('</ul>');
        }

        if (d.localTests) {
            var lt = d.localTests;
            h.push('<h2>Implications tested against data' + (lt.data ? ' (' + esc(lt.data) + ')' : '') + '</h2>');
            h.push('<p>' + esc(lt.sentence) + '</p>');
            h.push('<table><thead><tr><th>Implication</th><th>r</th><th>95% CI</th><th>p</th><th>p (Holm)</th><th>n</th><th>Verdict</th></tr></thead><tbody>');
            lt.tests.forEach(function (t) {
                if (t.skipped) h.push('<tr class="muted"><td class="path">' + esc(t.implication) + '</td><td colspan="5"></td><td>not tested — ' + esc(t.skipped) + '</td></tr>');
                else h.push('<tr><td class="path">' + esc(t.implication) + '</td><td>' + t.estimate.toFixed(2) + '</td><td>' +
                    t.ciLow.toFixed(2) + ' to ' + t.ciHigh.toFixed(2) + '</td><td>' + (t.p < 0.001 ? '&lt; .001' : t.p.toFixed(3)) + '</td><td>' +
                    (t.pHolm < 0.001 ? '&lt; .001' : t.pHolm.toFixed(3)) + '</td><td>' + t.n + '</td><td class="' + (t.violated ? 'bad' : 'ok') + '">' +
                    (t.violated ? 'violated' : 'consistent') + '</td></tr>');
            });
            h.push('</tbody></table>');
        }

        if (d.methodsStatement) {
            h.push('<h2>Assumptions statement</h2>');
            d.methodsStatement.split('\n\n').forEach(function (p) { h.push('<p>' + esc(p) + '</p>'); });
        }

        h.push('<h2>Reproduce</h2><p class="small muted">Model code (paste into DAGitty → Model code → Update, or into <code>dagitty()</code> in R):</p>');
        h.push('<pre>' + esc(d.modelCode) + '</pre>');
        h.push('<p class="small muted">R:</p><pre>' + esc(d.rCode) + '</pre>');

        h.push('<script type="application/json" id="dagitty-report-data">' +
            JSON.stringify(d).replace(/<\//g, '<\\/') + '</script>');
        h.push('</body></html>');
        return h.join('\n');
    }

    // ── Downloads ─────────────────────────────────────────────────────────

    function download(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    function stamp() { return new Date().toISOString().slice(0, 10); }

    function downloadHTML() {
        var d = collect();
        if (!d) return;
        var svg = '';
        try { if (window.PubExport && PubExport.svgMarkup) svg = PubExport.svgMarkup().replace(/^<\?xml[^>]*\?>\s*/, ''); }
        catch (e) { svg = ''; }
        download(new Blob([buildHTML(d, svg)], { type: 'text/html;charset=utf-8' }), 'dagitty-report-' + stamp() + '.html');
        if (window.Workspace && Workspace.toast) Workspace.toast('Report saved — one file with the figure, analysis, methods text and model code.', 'ok');
    }

    function downloadJSON() {
        var d = collect();
        if (!d) return;
        download(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), 'dagitty-analysis-' + stamp() + '.json');
    }

    window.ReportExport = { collect: collect, buildHTML: buildHTML, downloadHTML: downloadHTML, downloadJSON: downloadJSON };

})();
