/* Tests for the GUI-layer modules in gui/js.
 *
 * These modules are browser IIFEs that attach themselves to `window`, so they
 * are evaluated here against a jsdom document with the handful of element ids
 * they look up, plus stubs for the globals main.js and the DAGitty controller
 * normally provide. Only their pure analysis functions are exercised.
 */

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const { JSDOM } = require("jsdom")
const dagitty = require("../../jslib/dagitty-node.js")
const underscore = require("underscore")

const dom = new JSDOM(
	'<!DOCTYPE html><html><body>' +
	'<div id="causal_effect"></div><div id="testable_implications"></div>' +
	'<textarea id="methods_text"></textarea><div id="diagram_check"></div>' +
	'<div id="paths_panel"></div><div id="canvas"></div>' +
	'<select id="causal_effect_kind"><option value="adj_total" selected>t</option>' +
	'<option value="adj_direct">d</option></select>' +
	'</body></html>', { url: "http://localhost/" })
const w = dom.window

global.window = w
global.document = w.document
global.NodeFilter = w.NodeFilter
global.Node = w.Node
global.getComputedStyle = w.getComputedStyle.bind(w)
global.localStorage = w.localStorage
global._ = underscore
Object.assign(global, {
	Graph: dagitty.Graph, GraphAnalyzer: dagitty.GraphAnalyzer, GraphParser: dagitty.GraphParser,
	GraphTransformer: dagitty.GraphTransformer, GraphSerializer: dagitty.GraphSerializer
})
// In a browser `window` IS the global scope, so a module may write
// `window.Foo = …` and another read bare `Foo`. Under Node the jsdom window is a
// separate object, so mirror what the modules publish back onto the global.
global.Model = w.Model = { dag: null }
global.DAGittyControl = w.DAGittyControl = {
	observe: function () {},
	getView: function () { return { edge_shapes: { get: function () {} }, getVertexShape: function () {} } }
}
global.displayHide = w.displayHide = function () {}
global.displayShow = w.displayShow = function () {}

const PUBLISHED = ["AdjustmentSets", "TabularFile", "DataModal", "UndoRedo", "MethodsExport", "DiagramCheck",
	"Paths", "LocalTests", "ReportExport", "StructuredEditor"]
const load = (f) => {
	vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../../gui/js", f), "utf8"), { filename: f })
	PUBLISHED.forEach(k => { if (w[k] !== undefined) global[k] = w[k] })
}
;["causal-discovery.js", "ui-enhancements.js", "methods-export.js", "diagram-check.js",
  "paths-panel.js", "local-tests.js", "report-export.js", "structured-editor.js"].forEach(load)
w.CausalDiscovery = global.CausalDiscovery

const $p = (s) => GraphParser.parseGuess(s)
const setModel = (s) => { Model.dag = $p(s); return Model.dag }
const near = (assert, a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, (msg || "") + " (" + a + " vs " + b + ")")

// Deterministic data: mulberry32 + Box–Muller.
function rng(seed) {
	let a = seed >>> 0
	return function () {
		a = (a + 0x6D2B79F5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
function normals(n, seed) {
	const u = rng(seed), out = new Array(n)
	for (let i = 0; i < n; i++) {
		const a = Math.max(u(), 1e-12), b = u()
		out[i] = Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b)
	}
	return out
}
/** A → B → C chain, optionally with a direct A → C effect the diagram omits. */
function chainData(n, directAC, seed) {
	const zA = normals(n, seed), zB = normals(n, seed + 1), zC = normals(n, seed + 2)
	const A = zA, B = A.map((a, i) => 0.8 * a + zB[i])
	const C = B.map((b, i) => 0.8 * b + directAC * A[i] + zC[i])
	return { headers: ["A", "B", "C"], columns: { A, B, C }, nRows: n }
}

QUnit.module("gui modules")

QUnit.test("AdjustmentSets.minimal ignores the current adjustments", function (assert) {
	let g = $p('dag { E [exposure] M [adjusted] D [outcome] E -> M M -> D }')
	assert.deepEqual(AdjustmentSets.minimal(g, "total"), [[]], "mediator adjusted: nothing is needed for the total effect")
	assert.deepEqual(AdjustmentSets.minimal(g, "direct"), [["M"]], "the mediator IS the set for the direct effect")
	assert.ok(AdjustmentSets.isOneOf(g, [["M"]]))

	g = $p('dag { E [exposure] D [outcome] C X [adjusted] C -> E C -> D E -> D X -> D }')
	assert.deepEqual(AdjustmentSets.minimal(g, "total"), [["C"]])
	assert.notOk(AdjustmentSets.isOneOf(g, [["C"]]))

	g = $p('dag { A B D [outcome] E [exposure] Z [adjusted] A -> E A -> Z B -> D B -> Z E -> D }')
	assert.deepEqual(AdjustmentSets.minimal(g, "total"), [[]], "collider adjusted: the right answer is no adjustment")
	assert.notOk(GraphAnalyzer.isAdjustmentSet(g), "…and the chosen set {Z} is indeed insufficient")
	assert.deepEqual(GraphAnalyzer.listMsasTotalEffect(g).map(s => _.pluck(s, "id").sort()).sort(),
		[["A", "Z"], ["B", "Z"]], "(the constrained library call only lists supersets of Z)")
})

QUnit.test("DiagramCheck names the variable and the mistake", function (assert) {
	setModel('dag { E [exposure] M [adjusted] D [outcome] E -> M M -> D }')
	const med = DiagramCheck.analyse().find(f => f.subject === "M")
	assert.ok(med && med.level === "warn" && /mediator/.test(med.text), "adjusted mediator")

	setModel('dag { E [exposure] D [outcome] D -> E }')
	assert.ok(DiagramCheck.analyse().some(f => f.level === "error" && /wrong way round/.test(f.text)), "reversed arrow")

	setModel('dag { A B D [outcome] E [exposure] Z [adjusted] A -> E A -> Z B -> D B -> Z E -> D }')
	assert.ok(DiagramCheck.analyse().some(f => f.subject === "Z" && /collider/.test(f.text)), "adjusted collider")

	setModel('dag { E [exposure] D [outcome] L [latent] E -> D L -> E L -> D }')
	assert.ok(DiagramCheck.analyse().some(f => f.subject === "L" && /unmeasured common cause/.test(f.text)))
})

QUnit.test("methods statement is honest about a wrong adjustment set", function (assert) {
	setModel('dag { E [exposure] M [adjusted] D [outcome] C E -> M M -> D C -> E C -> D }')
	const t = MethodsExport.generate()
	assert.ok(/NOT sufficient/.test(t), "says the chosen set fails")
	assert.ok(/must not be adjusted for/.test(t), "says why (mediator)")
	assert.ok(/\{C\}/.test(t), "names the set that works")
	assert.notOk(/not identifiable/.test(t), "does NOT claim the effect is unidentifiable")

	setModel('dag { E [exposure] D [outcome] C X [adjusted] C [adjusted] C -> E C -> D E -> D X -> D }')
	assert.ok(/A smaller set would also suffice/.test(MethodsExport.generate()))

	// graph-validation.js switches on parse-time validation for the whole run,
	// so build the cycle after parsing rather than in the model code.
	setModel('dag { A [exposure] B [outcome] A -> B }').addEdge("B", "A")
	const c = MethodsExport.generate()
	assert.ok(/A→B→A|B→A→B/.test(c), "cycle rendered with a real arrow")
	assert.notOk(/&rarr;/.test(c), "no HTML entity in a textarea")
})

QUnit.test("Paths classifies each path and explains why it is open or blocked", function (assert) {
	const g = $p('dag { A B D [outcome] E [exposure] Z [adjusted] A -> E A -> Z B -> D B -> Z E -> D }')
	const r = Paths.analyse(g, "total")
	assert.equal(r.paths.length, 2)
	const causal = r.paths.find(p => p.causal), bias = r.paths.find(p => !p.causal)
	assert.equal(causal.text, "E → D")
	assert.ok(causal.open)
	assert.equal(bias.text, "E ← A → Z ← B → D")
	assert.ok(bias.open, "adjusting for the collider Z opens the path")
	assert.ok(/adjusted for Z, a collider/.test(bias.explanation), bias.explanation)
	assert.equal(r.openBiasing, 1)
	assert.equal(r.paths[0], bias, "open biasing paths are listed first")

	g.removeAdjustedNode(g.getVertex("Z"))
	const b2 = Paths.analyse(g, "total").paths.find(p => !p.causal)
	assert.notOk(b2.open)
	assert.ok(/collider you have not adjusted for/.test(b2.explanation), b2.explanation)

	g.addAdjustedNode(g.getVertex("A"))
	const b3 = Paths.analyse(g, "total").paths.find(p => !p.causal)
	assert.notOk(b3.open)
	assert.ok(/blocked by adjusting for A/i.test(b3.explanation), b3.explanation)

	const g3 = $p('dag { E [exposure] M [adjusted] D [outcome] E -> M M -> D }')
	const p3 = Paths.analyse(g3, "total").paths[0]
	assert.ok(p3.causal && !p3.open && /mediator/.test(p3.explanation), p3.explanation)
	assert.ok(/intended/.test(Paths.analyse(g3, "direct").paths[0].explanation), "same adjustment is fine for a direct effect")

	assert.equal(Paths.analyse($p('dag { E D }'), "total"), null, "no roles → null")
	const cyc = $p('dag { E [exposure] D [outcome] E -> D }')
	cyc.addEdge("D", "E")
	assert.ok(Paths.analyse(cyc, "total").cyclic)
})

QUnit.test("CausalDiscovery.normalCDF is the standard normal CDF", function (assert) {
	near(assert, CausalDiscovery.normalCDF(0), 0.5, 1e-7)
	near(assert, CausalDiscovery.normalCDF(1.959964), 0.975, 2e-6, "Φ(1.96)")
	near(assert, CausalDiscovery.normalCDF(-1.959964), 0.025, 2e-6, "Φ(−1.96)")
	near(assert, CausalDiscovery.normalCDF(1), 0.8413447, 2e-6, "Φ(1)")
	near(assert, CausalDiscovery.fisherZPVal(0.3, 100, 0), 0.00230, 3e-4, "Fisher z p-value, r = .3, n = 100")
})

QUnit.test("LocalTests: Fisher z test and Holm correction", function (assert) {
	const t = LocalTests.fisherTest(0.3, 100, 0)
	near(assert, t.z, 3.0485, 0.002, "z statistic")
	near(assert, t.p, 0.00230, 0.0003, "two-sided p")
	near(assert, t.lo, 0.1101, 0.002, "CI lower")
	near(assert, t.hi, 0.4689, 0.002, "CI upper")
	assert.equal(LocalTests.fisherTest(0.3, 4, 1), null, "too few cases → null")
	assert.deepEqual(LocalTests.holm([0.01, 0.04, 0.03]).map(x => +x.toFixed(4)), [0.03, 0.06, 0.06])
	assert.deepEqual(LocalTests.autoMap(["Prior Experience", "Adoption", "Nope"], ["prior_experience", "adoption", "x"]),
		{ "Prior Experience": "prior_experience", Adoption: "adoption", Nope: null })
})

QUnit.test("LocalTests.run tests the implied independencies against data", function (assert) {
	const g = $p('dag { A [exposure] B C [outcome] A -> B B -> C }')
	const ok = LocalTests.run(g, chainData(3000, 0, 11), { A: "A", B: "B", C: "C" }, 0.05)
	assert.equal(ok.summary.nImplied, 1, "chain implies exactly A ⊥ C | B")
	assert.equal(ok.summary.tested, 1)
	assert.deepEqual([ok.tests[0].imp.x, ok.tests[0].imp.y, ok.tests[0].imp.z], ["A", "C", ["B"]])
	assert.notOk(ok.tests[0].violated, "consistent data: not violated (p = " + ok.tests[0].p.toFixed(3) + ")")
	assert.equal(ok.tests[0].n, 3000)
	assert.ok(/None was rejected/.test(LocalTests.methodsSentence(ok)))

	const bad = LocalTests.run(g, chainData(3000, 0.6, 12), { A: "A", B: "B", C: "C" }, 0.05)
	assert.ok(bad.tests[0].violated, "a direct A → C effect the diagram omits is detected")
	assert.ok(bad.tests[0].pHolm < 0.05)
	assert.ok(/1 was rejected: A ⊥ C \| B/.test(LocalTests.methodsSentence(bad)), LocalTests.methodsSentence(bad))

	const skipped = LocalTests.run(g, chainData(50, 0, 13), { A: "A", B: null, C: "C" }, 0.05)
	assert.ok(/not in the data: B/.test(skipped.tests[0].skipped))
	assert.equal(skipped.summary.tested, 0)

	// Missing values are handled per test, not by dropping rows up front.
	const tbl = chainData(400, 0, 14)
	tbl.columns.A[3] = NaN
	assert.equal(LocalTests.run(g, tbl, { A: "A", B: "B", C: "C" }, 0.05).tests[0].n, 399)

	assert.ok(/implication\testimate/.test(LocalTests.toTSV(ok)))
})

QUnit.test("CausalDiscovery.parseTable keeps partial rows and drops text columns", function (assert) {
	const t = CausalDiscovery.parseTable('a;b;name\n1;2;x\n2;NA;y\n3;4;"z;z"\n4;5;w')
	assert.deepEqual(t.headers, ["a", "b"])
	assert.equal(t.nRows, 4)
	assert.ok(isNaN(t.columns.b[1]), "NA becomes NaN")
	assert.deepEqual(t.columns.a, [1, 2, 3, 4])
	assert.deepEqual(t.dropped, ["name"])
	const q = CausalDiscovery.parseTable('x,y\n"1,5",2\n3,4\n5,6\n"say ""hi""",8')
	assert.deepEqual(q.headers, ["y"], "a quoted column with commas inside is text, not numbers")
})

QUnit.test("CausalDiscovery.enforceAcyclic removes a directed cycle", function (assert) {
	const dirAdj = [[false, true, false], [false, false, true], [true, false, false]]
	const adj = [[false, false, false], [false, false, false], [false, false, false]]
	const res = { adj, dirAdj, vars: ["a", "b", "c"], rank: [0, 1, 2],
		corrMat: [[1, .5, .2], [.5, 1, .5], [.2, .5, 1]] }
	const r = CausalDiscovery.enforceAcyclic(res)
	assert.ok(r.reversed + r.relaxed >= 1)
	// No directed cycle remains (3 nodes: check every rotation).
	const cyc = (i, j, k) => dirAdj[i][j] && dirAdj[j][k] && dirAdj[k][i]
	assert.notOk(cyc(0, 1, 2) || cyc(0, 2, 1))
	assert.ok(dirAdj[2][0] === false, "the edge most against the causal order (c → a) was the one changed")
})

QUnit.test("CausalDiscovery.pcAlgorithm recovers a chain skeleton", function (assert) {
	const tbl = chainData(2000, 0, 21)
	const rows = []
	for (let i = 0; i < tbl.nRows; i++) rows.push({ A: tbl.columns.A[i], B: tbl.columns.B[i], C: tbl.columns.C[i] })
	const r = CausalDiscovery.pcAlgorithm(rows, ["A", "B", "C"], 0.05)
	const linked = (i, j) => r.adj[i][j] || r.dirAdj[i][j] || r.dirAdj[j][i]
	assert.ok(linked(0, 1) && linked(1, 2), "A–B and B–C kept")
	assert.notOk(linked(0, 2), "A–C removed given B")
})

QUnit.test("ReportExport.collect bundles the analysis, and the HTML embeds it as JSON", function (assert) {
	setModel('dag { E [exposure] D [outcome] C C -> E C -> D E -> D }')
	const d = ReportExport.collect()
	assert.deepEqual(d.roles.exposure, ["E"])
	assert.deepEqual(d.roles.other, ["C"])
	assert.deepEqual(d.adjustment.minimalSets, [["C"]])
	assert.strictEqual(d.adjustment.sufficient, false)
	assert.equal(d.paths.list.length, 2)
	assert.ok(/NOTE|confounded/.test(d.methodsStatement))
	const html = ReportExport.buildHTML(d, "<svg></svg>")
	const m = html.match(/<script type="application\/json" id="dagitty-report-data">([\s\S]*?)<\/script>/)
	assert.ok(m, "JSON block present")
	assert.equal(JSON.parse(m[1].replace(/<\\\//g, "</")).modelCode, d.modelCode)
	assert.ok(html.indexOf("<svg></svg>") !== -1, "figure inlined")
})

QUnit.test("StructuredEditor helpers", function (assert) {
	const g = $p('dag { E [exposure,pos="0,0"] D [outcome,pos="1,0"] E -> D }')
	assert.equal(StructuredEditor.roleOf(g, g.getVertex("E")), "source")
	assert.equal(StructuredEditor.roleOf(g, g.getVertex("D")), "target")
	assert.ok(StructuredEditor.edgeBetween(g, "D", "E"), "finds the edge whichever way round it is asked")
	assert.notOk(StructuredEditor.edgeBetween(g, "E", "E"))
	const p = StructuredEditor.placeNew(g)
	assert.ok(p[0] > 1, "new variables go to the right of the drawing")
	assert.deepEqual(StructuredEditor.placeNew($p("dag { }")), [0, 0])
})
