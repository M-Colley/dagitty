/* Regression checks for causal reporting and data-validation failures. */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { JSDOM } = require('jsdom')
const dagitty = require('../../jslib/dagitty-node.js')

function environment() {
    const dom = new JSDOM('<!doctype html><body><select id="causal_effect_kind"><option value="adj_total">total</option></select></body>')
    const loadHandlers = []
    const ctx = {
        document: dom.window.document, _: require('underscore'),
        Model: { dag: null }, addEventListener(type, fn) { if (type === 'load') loadHandlers.push(fn) }, setTimeout() {}, clearTimeout() {},
        console, navigator: {}, location: { origin: 'http://localhost', pathname: '/' },
        Graph: dagitty.Graph, GraphParser: dagitty.GraphParser,
        GraphAnalyzer: dagitty.GraphAnalyzer, GraphTransformer: dagitty.GraphTransformer,
        GraphSerializer: dagitty.GraphSerializer
    }
    ctx.window = ctx
    vm.createContext(ctx)
    ;['causal-discovery.js', 'methods-export.js', 'local-tests.js', 'paths-panel.js', 'diagram-check.js', 'report-export.js'].forEach(file => {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../gui/js', file), 'utf8'), ctx, { filename: file })
    })
    ctx.fireLoad = () => loadHandlers.forEach(fn => fn())
    return ctx
}

QUnit.module('causal UX regressions')

QUnit.test('undefined correlations cannot pass as independence', assert => {
    const c = environment(), lt = c.LocalTests
    const x = [1, 2, 3, 4, 5, 6, 7, 8]
    assert.ok(/constant/.test(lt.partialFromColumns([x, x.map(() => 1)]).error))
    assert.strictEqual(lt.fisherTest(NaN, 100, 0), null)
    assert.strictEqual(lt.fisherTest(1.2, 100, 0), null)
    assert.ok(Number.isNaN(c.CausalDiscovery.partialCorr([[1, 1, 1], [1, 1, 1], [1, 1, 1]], 0, 1, [2])), 'singular matrix is not zero correlation')
    assert.ok(Number.isNaN(c.CausalDiscovery.fisherZPVal(NaN, 100, 0)))
    assert.ok(Number.isNaN(c.CausalDiscovery.fisherZPVal(.1, 4, 1)), 'insufficient Fisher degrees of freedom')
    const g = c.GraphParser.parseGuess('dag { A B }')
    const result = lt.run(g, { columns: { value: x } }, { A: 'value', B: 'value' }, .05)
    assert.equal(result.summary.tested, 0, 'one column cannot represent two variables in a test')
    assert.ok(/same data column/.test(result.tests[0].skipped))
    assert.throws(() => lt.run(g, { columns: {} }, {}, 2), /significance level/)
})

QUnit.test('data parsing rejects ambiguous headers and numeric prefixes', assert => {
    const c = environment(), discovery = c.CausalDiscovery
    assert.throws(() => discovery.parseTable('A,A\n1,2\n2,3\n3,4'), /Duplicate column/)
    const data = discovery.parseCSV('A,B,bad\n1,2,12abc\n2,4,13abc\n3,6,14abc\n4,8,15abc\n5,10,16abc\n6,12,17abc')
    assert.deepEqual(Array.from(data.headers), ['A', 'B'], 'partial numeric strings are text')
    const match = c.LocalTests.autoMap(['prior experience'], ['Prior_Experience', 'prior-experience'])
    assert.strictEqual(match['prior experience'], null, 'ambiguous normalized matches need user input')
})

QUnit.test('discovery preserves unknown direction as an undirected PDAG edge', assert => {
    const c = environment()
    const result = c.CausalDiscovery.discoverFromCSV('A,B\n1,1\n2,2\n3,3\n4,4\n5,5\n6,6\n7,7\n8,8', .05, false)
    assert.ok(/^pdag \{/.test(result.modelCode))
    assert.ok(/A -- B/.test(result.modelCode))
    assert.notOk(/<->/.test(result.modelCode), 'unknown direction does not assert an unmeasured common cause')
    assert.equal(c.GraphParser.parseGuess(result.modelCode).getType(), 'pdag', 'native model code parses')
    const partial = c.GraphParser.parseGuess('pdag { A [exposure] B [outcome] A -- B }')
    assert.ok(c.Paths.analyse(partial, 'total').uncertain, 'unknown directions are not classified as known biasing paths')
    c.Model.dag = partial
    const report = c.ReportExport.collect()
    assert.ok(report.paths.uncertain)
    assert.ok(/classifications are deferred/.test(c.ReportExport.buildHTML(report, '')))
})

QUnit.test('generated statements cannot recycle stale evidence or assert unrun checks', assert => {
    const c = environment()
    c.Model.dag = c.GraphParser.parseGuess('dag { A [exposure] B C [outcome] A -> B B -> C }')
    let text = c.MethodsExport.generate()
    assert.notOk(/We tested/.test(text), 'an unrun test is not claimed as completed')
    assert.ok(/REPORT CHECKS HERE/.test(text))
    c.MethodsExport.setLocalTestResults('UNIQUE_OLD_RESULT')
    assert.ok(c.MethodsExport.generate().includes('UNIQUE_OLD_RESULT'))
    c.Model.dag = c.GraphParser.parseGuess('dag { A [exposure] D C [outcome] A -> D D -> C }')
    assert.notOk(c.MethodsExport.generate().includes('UNIQUE_OLD_RESULT'), 'direct export before refresh discards stale results')
    c.Model.dag = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] U [latent] S [selected] U -> E U -> Y E -> S Y -> S }')
    text = c.MethodsExport.generate()
    assert.notOk(/no unmeasured confounding/.test(text), 'explicit latent confounding is not denied')
    assert.ok(/does not by itself correct selection bias/.test(text))
    const summary = c.LocalTests.methodsSentence({ summary: {
        nMin: 100, nMax: 100, tested: 1, nImplied: 1, capped: false,
        violated: 0, violatedHolm: 0, skipped: 0, alpha: .05
    }, tests: [] })
    assert.ok(/does not establish independence/.test(summary))
})

QUnit.test('paths name conditioned collider descendants and avoid adjusting for latent mediators', assert => {
    const c = environment()
    const g = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] A B C S [selected] A -> E A -> C B -> Y B -> C C -> S E -> Y }')
    const bias = c.Paths.analyse(g, 'total').paths.find(p => !p.causal)
    assert.ok(bias.open)
    assert.ok(/conditioning on S activates C/.test(bias.explanation), bias.explanation)
    const mediated = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] M [latent] E -> M M -> Y }')
    assert.ok(/Every mediator on this path is unobserved/.test(c.Paths.analyse(mediated, 'direct').paths[0].explanation))
})

QUnit.test('report uses the shared R export', assert => {
    const c = environment()
    c.Model.dag = c.GraphParser.parseGuess('dag { A [exposure] B [outcome] A -> B }')
    c.RCodeExport = { generate: graph => 'SHARED R CODE FOR ' + graph.getType() }
    assert.equal(c.ReportExport.collect().rCode, 'SHARED R CODE FOR dag')
})

QUnit.test('methods and report respect the selected identification strategy', assert => {
    const c = environment(), kind = c.document.getElementById('causal_effect_kind')
    kind.innerHTML = '<option value="adj_causalodds">odds ratio</option><option value="adj_direct">direct</option>'
    // Total-effect adjustment fails under outcome-dependent selection, while
    // the selection-specific causal-odds-ratio criterion allows this graph.
    c.Model.dag = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] S [selected] E -> Y Y -> S }')
    assert.notOk(c.GraphAnalyzer.isAdjustmentSet(c.Model.dag))
    assert.ok(c.GraphAnalyzer.isAdjustmentSetCausalOddsRatio(c.Model.dag))
    assert.ok(/passes DAGitty's causal-odds-ratio criterion/.test(c.MethodsExport.generate()))
    let report = c.ReportExport.collect()
    assert.strictEqual(report.adjustment.sufficient, true)
    assert.strictEqual(report.adjustment.minimalSets, null, 'total-effect sets are not substituted for odds-ratio sets')
    kind.value = 'adj_direct'
    assert.ok(/does not support direct-effect adjustment/.test(c.MethodsExport.generate()))
    report = c.ReportExport.collect()
    assert.strictEqual(report.adjustment.supported, false)
    assert.strictEqual(report.adjustment.sufficient, null)
})

QUnit.test('layout edits preserve test evidence while model assumptions invalidate it', assert => {
    const c = environment()
    const g = c.Model.dag = c.GraphParser.parseGuess('dag { A [exposure,pos="0,0"] B [pos="1,1"] C [outcome,pos="2,0"] A -> B B -> C }')
    const a = Array.from({ length: 30 }, (_, i) => Math.sin(i) + i / 10)
    const b = a.map((v, i) => v + Math.cos(i))
    const d = b.map((v, i) => v + Math.sin(i * 2))
    const result = c.LocalTests.last = c.LocalTests.run(g, { columns: { a, b, c: d } }, { A: 'a', B: 'b', C: 'c' }, .05)
    const originalKey = c.AnalysisModelKey(g), originalCode = g.toString()
    c.MethodsExport.setLocalTestResults('PRESERVED_TEST_EVIDENCE')
    g.getVertex('B').layout_pos_x = 12
    g.getVertex('B').layout_pos_y = 8
    g.getEdges()[0].layout_pos_x = 4
    g.getEdges()[0].layout_pos_y = -3
    g.setBoundingBox([-5, -5, 15, 15])
    assert.notEqual(g.toString(), originalCode, 'drawing and saved reproduction code changed')
    assert.equal(c.AnalysisModelKey(g), originalKey, 'causal signature excludes coordinates and arrow curves')
    assert.ok(c.LocalTests.matchesModel(result, g))
    assert.ok(c.MethodsExport.generate().includes('PRESERVED_TEST_EVIDENCE'))
    assert.ok(c.ReportExport.collect().localTests, 'report retains evidence after a drag')
    assert.equal(c.ReportExport.collect().modelCode, g.toString(), 'report reproduces the current drawing')
    const reordered = c.GraphParser.parseGuess('dag { C [outcome] B A [exposure] B -> C A -> B }')
    assert.equal(c.AnalysisModelKey(reordered), originalKey, 'insertion order does not change the model')
    g.addEdge('A', 'C')
    assert.notOk(c.LocalTests.matchesModel(result, g), 'a new causal edge invalidates evidence')
    assert.notOk(c.MethodsExport.generate().includes('PRESERVED_TEST_EVIDENCE'))
    assert.strictEqual(c.ReportExport.collect().localTests, null)
    g.deleteEdge('A', 'C', c.Graph.Edgetype.Directed)
    c.MethodsExport.setLocalTestResults('ROLE_BOUND_EVIDENCE')
    g.addLatentNode(g.getVertex('B'))
    assert.notOk(c.LocalTests.matchesModel(result, g), 'changing observed status invalidates evidence')
    assert.notOk(c.MethodsExport.generate().includes('ROLE_BOUND_EVIDENCE'))
})

QUnit.test('MAG and PAG path limitations are not described as PDAG uncertainty', assert => {
    const c = environment()
    const mag = c.GraphParser.parseGuess('mag { A [exposure] B [outcome] A -- B }')
    const pag = c.GraphParser.parseGuess('pag { A [exposure] B [outcome] A @-> B }')
    c.Model.dag = mag
    assert.ok(/causal graph \(MAG\)/.test(c.MethodsExport.generate()))
    assert.strictEqual(c.Paths.analyse(mag, 'total').partial, false)
    assert.strictEqual(c.Paths.analyse(pag, 'total').partial, false)
    const html = c.ReportExport.buildHTML(c.ReportExport.collect(), '')
    assert.ok(/does not classify the edge types/.test(html))
    assert.notOk(/directions are unresolved/.test(html))
})

QUnit.test('correlation and local tests are invariant to measurement units', assert => {
    const c = environment()
    const x = Array.from({ length: 30 }, (_, i) => i + Math.sin(i))
    const y = x.map((v, i) => .4 * v + Math.cos(i))
    const small = c.CausalDiscovery.pearsonR(x.map(v => v * 1e-15), y.map(v => v * 1e-15))
    const large = c.CausalDiscovery.pearsonR(x.map(v => v * 1e200), y.map(v => v * 1e200))
    const expected = c.CausalDiscovery.pearsonR(x, y)
    assert.ok(expected > .9)
    assert.ok(Math.abs(small - expected) < 1e-12, 'small-valued measurements are not replaced by zero correlation')
    assert.ok(Math.abs(large - expected) < 1e-12, 'large finite measurements do not overflow')
    const g = c.GraphParser.parseGuess('dag { X Y }')
    const ordinary = c.LocalTests.run(g, { columns: { x, y } }, { X: 'x', Y: 'y' }, .05)
    const scaled = c.LocalTests.run(g, { columns: { x: x.map(v => v * 1e-15), y: y.map(v => v * 1e-15) } }, { X: 'x', Y: 'y' }, .05)
    assert.equal(scaled.tests[0].violated, ordinary.tests[0].violated)
    assert.ok(Math.abs(scaled.tests[0].estimate - ordinary.tests[0].estimate) < 1e-12)
})

QUnit.test('bidirected connections and object-property names remain ordinary graph relationships', assert => {
    const c = environment()
    c.Model.dag = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] E <-> Y }')
    assert.notOk(c.DiagramCheck.analyse().some(f => /has no arrows|have no arrows/.test(f.text)), 'a bidirected edge does not imply isolation')
    // Exercise the path walker independently: upstream GraphParser rejects
    // some object-property names, and the wizard already explains that limit.
    const walked = c.Paths.walk({ getEdges: () => [{
        v1: { id: 'constructor' }, v2: { id: '__proto__' }, directed: c.Graph.Edgetype.Directed
    }] }, ['constructor'])
    assert.deepEqual(Array.from(walked.nodes), ['constructor', '__proto__'])
    assert.deepEqual(Array.from(walked.steps), ['->'])
})

QUnit.test('methods preview and clipboard follow the current strategy and most recent edit', assert => {
    const c = environment(), doc = c.document, kind = doc.getElementById('causal_effect_kind')
    kind.innerHTML = '<option value="adj_total">total</option><option value="adj_direct">direct</option>'
    const preview = doc.createElement('textarea')
    preview.id = 'methods_text'; doc.body.appendChild(preview)
    c.Model.dag = c.GraphParser.parseGuess('dag { E [exposure] M [adjusted] Y [outcome] E -> M M -> Y }')
    c.fireLoad()
    c.MethodsExport.refresh()
    assert.ok(/total effect/.test(preview.value))
    kind.value = 'adj_direct'
    kind.dispatchEvent(new doc.defaultView.Event('change'))
    assert.ok(/the direct effect/.test(preview.value), 'changing strategy updates the visible statement')
    assert.notOk(/NOT sufficient/.test(preview.value), 'the mediator adjustment is valid for this direct effect')
    let copied = ''
    c.navigator.clipboard = { writeText(value) { copied = value; return Promise.resolve() } }
    c.Model.dag = c.GraphParser.parseGuess('dag { X [exposure] Z [outcome] X -> Z }')
    c.MethodsExport.copy()
    assert.ok(/effect of X on Z/.test(copied), 'copy refreshes even before a debounced graphchange has run')
    assert.equal(preview.value, copied)
})

QUnit.test('selection failures and conditioned mediators are described consistently', assert => {
    const c = environment()
    c.Model.dag = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] S [selected] E -> Y Y -> S }')
    const text = c.MethodsExport.generate()
    assert.ok(/no measured-variable set meets the adjustment criterion/.test(text))
    assert.ok(/requirements for the selection mechanism/.test(text), 'selection failure is not falsely attributed to open confounding')
    const g = c.GraphParser.parseGuess('dag { E [exposure] Y [outcome] S [selected] E -> S S -> Y }')
    const path = c.Paths.analyse(g, 'total').paths[0]
    assert.notOk(path.open)
    assert.ok(/sample selection on S/.test(path.explanation))
    assert.notOk(/you adjusted/.test(path.explanation))
    assert.ok(/does not support direct-effect/.test(c.Paths.analyse(g, 'direct').paths[0].explanation))
})

QUnit.test('discovery rejects unsupported graph ids without restricting local-test data columns', async assert => {
    const c = environment()
    const csvFor = name => '"' + name.replace(/"/g, '""') + '",Outcome\n1,2\n2,4\n3,6\n4,8\n5,10\n6,12'
    for (const name of ['graph', 'node', '__proto__', 'constructor', 'toString', 'Risk\\group']) {
        assert.throws(() => c.CausalDiscovery.parseCSV(csvFor(name)), /Rename this column/, name + ' gets an actionable discovery error')
        const table = c.CausalDiscovery.parseTable(csvFor(name))
        assert.ok(table.headers.includes(name), name + ' remains available for mapping in local tests')
        assert.equal(table.columns[name].length, 6)
    }
    await assert.rejects(c.CausalDiscovery.discoverFromCSVAsync(csvFor('graph'), .05, false), /reserved by the diagram engine/,
        'the worker/main-thread discovery pipeline rejects before generating unusable model code')
    const supported = c.CausalDiscovery.discoverFromCSV(csvFor('Hours "online" {daily}'), .05, false)
    assert.ok(c.GraphParser.parseGuess(supported.modelCode).getVertex('Hours "online" {daily}'), 'supported descriptive names still round-trip')
    const metadata = c.CausalDiscovery.parseCSV('A,B,graph\n1,2,text\n2,4,text\n3,6,text\n4,8,text\n5,10,text\n6,12,text')
    assert.deepEqual(Array.from(metadata.headers), ['A', 'B'], 'text metadata does not become a graph variable and needs no rename')
})

QUnit.test('discovery complete cases and validation use only selected columns', async assert => {
    const c = environment()
    c.setTimeout = setTimeout
    c.clearTimeout = clearTimeout
    const csv = 'A,B,Optional,graph\n1,2,1,1\n2,5,2,2\n3,3,NA,3\n4,8,NA,4\n5,4,NA,5\n6,9,NA,6\n7,6,NA,7'
    const result = await c.CausalDiscovery.discoverFromCSVAsync(csv, .05, false, null,
        { excludeVars: ['Optional', 'graph'], maxCondSize: 1, corrThreshold: 0 })
    assert.equal(result.n, 7, 'missing data in unchecked columns does not remove observations')
    assert.equal(result.nodeCount, 2)
    assert.deepEqual(Array.from(result.vars), ['A', 'B'])
    assert.notOk(result.warnings.some(w => /missing values|row\(s\).*skipped/.test(w)), 'the reported sample does not retain obsolete row exclusions')
    const graph = c.GraphParser.parseGuess(result.modelCode)
    assert.equal(graph.getVertices().length, 2, 'reserved names in excluded columns never reach the diagram')
    await assert.rejects(c.CausalDiscovery.discoverFromCSVAsync(csv, .05, false, null,
        { excludeVars: ['B', 'Optional', 'graph'] }), /after exclusions/, 'at least two selected numeric variables are still required')
    const missingSelected = 'A,B,Optional\n1,2,NA\n2,NA,NA\n3,3,1\n4,8,NA\n5,4,NA\n6,9,2\n7,6,NA'
    const subset = await c.CausalDiscovery.discoverFromCSVAsync(missingSelected, .05, false, null,
        { excludeVars: ['Optional'], corrThreshold: 0 })
    assert.equal(subset.n, 6, 'missing values in a selected variable still remove that row')
    assert.ok(subset.warnings.some(w => /1 row\(s\).*missing/.test(w)))
})
