/* Exercise the real browser engine, main.js and UI wrappers against the actual
 * page DOM. Only rendering/controller plumbing and network responses are stubbed. */
const mcFs = require('fs')
const mcPath = require('path')
const { JSDOM: ModelCodeDOM } = require('jsdom')

async function modelCodeFixture() {
    const gui = mcPath.join(__dirname, '../../gui')
    const dom = new ModelCodeDOM(mcFs.readFileSync(mcPath.join(gui, 'dags.html'), 'utf8'),
        { url: 'http://localhost/', runScripts: 'outside-only' })
    const w = dom.window, d = w.document, events = {}, messages = []
    const script = file => w.eval(mcFs.readFileSync(mcPath.join(gui, 'js', file), 'utf8'))
    script('dagitty.js'); script('styles/original.js'); script('example-dags.js'); script('main.js')
    const inline = Array.from(d.scripts).find(el => el.textContent.includes('function initialize()'))
    w.eval(inline.textContent)
    let graph = w.GraphParser.parseGuess('dag { E [exposure,pos="0,0"] O [outcome,pos="1,0"] E -> O }')
    let closed = 0, biasMode = 'normal'
    const emit = event => (events[event] || []).forEach(fn => fn(graph))
    const view = { closeDialog: () => { closed++ }, resize: () => {},
        getImplementation: () => ({ stopMousemove: () => {} }) }
    const controller = {
        observe: (event, fn) => { (events[event] || (events[event] = [])).push(fn) },
        graphChanged: () => emit('graphchange'),
        getGraph: () => graph,
        getView: () => view,
        setGraph: next => { graph = next; emit('graphchange') },
        // Run the same bias transformations used before drawing the SVG, so a
        // graph unsupported by direct/odds analysis cannot be hidden by a stub.
        setBiasMode: mode => {
            biasMode = mode
            w.GraphTransformer.activeBiasGraph(graph)
            if (mode === 'direct') w.GraphTransformer.activeBiasGraph(graph, { direct: true })
            if (mode === 'causalodds' && graph.getSources().length === 1 && graph.getTargets().length === 1 && graph.getSelectedNodes().length === 1)
                w.GraphTransformer.activeSelectionBiasGraph(graph, graph.getSources()[0], graph.getTargets()[0], graph.getSelectedNodes())
        },
        redraw: () => {}
    }
    w.DAGitty.setup = () => { w.DAGitty.controllers = [controller] }
    w.Workspace = { toast: text => messages.push(text) }
    script('ui-enhancements.js')
    await new Promise(resolve => w.addEventListener('load', resolve, { once: true }))
    const $ = id => d.getElementById(id)
    const edit = text => { $('adj_matrix').value = text; w.modelCodeChanged() }
    return { w, d, $, edit, messages, emit, controller, graph: () => graph,
        biasMode: () => biasMode, closed: () => closed,
        settle: () => new Promise(resolve => w.setTimeout(resolve, 125)), close: () => w.close() }
}

QUnit.module('raw model code integration')

QUnit.test('invalid syntax keeps the graph and draft; a corrected Update commits and clears dirty state', async assert => {
    const t = await modelCodeFixture()
    const original = t.graph()
    const draft = 'dag { E [exposure] O [outcome] E -> }'
    t.edit(draft)
    assert.strictEqual(t.w.loadDAGFromTextData(), false)
    assert.strictEqual(t.graph(), original, 'the installed graph remains the same object')
    assert.strictEqual(t.w.Model.dag, original)
    assert.equal(t.$('adj_matrix').value, draft)
    assert.ok(t.$('adj_matrix').classList.contains('dirty'))
    assert.equal(t.$('model_refresh').getAttribute('role'), 'alert')
    assert.ok(/Could not read/.test(t.$('model_refresh').textContent))
    t.edit('dag { Treatment [exposure] Recovery [outcome] Treatment -> Recovery }')
    assert.strictEqual(t.w.loadDAGFromTextData(), true)
    assert.ok(t.graph().getVertex('Treatment'))
    assert.notOk(t.$('adj_matrix').classList.contains('dirty'))
    assert.equal(t.$('adj_matrix').value, t.graph().toString(), 'the actual page graph observer normalizes applied code')
    assert.equal(t.$('model_refresh').style.display, 'none')
    t.close()
})

QUnit.test('canvas graph and layout notifications preserve an unapplied code draft', async assert => {
    const t = await modelCodeFixture()
    t.edit('dag { My unfinished draft')
    const draft = t.$('adj_matrix').value
    t.graph().addVertex('Added on canvas'); t.emit('graphchange')
    t.graph().getVertex('E').layout_pos_y = 3; t.emit('graphlayoutchange')
    assert.equal(t.$('adj_matrix').value, draft, 'both actual inline page observers retain raw edits')
    assert.ok(t.$('adj_matrix').classList.contains('dirty'))
    t.close()
})

QUnit.test('pending code blocks New, examples, Undo and Redo without consuming history', async assert => {
    const t = await modelCodeFixture()
    await t.settle()
    t.edit('dag { Extra [pos="2,0"] E [exposure,pos="0,0"] O [outcome,pos="1,0"] E -> O }')
    t.w.loadDAGFromTextData()
    const editedGraph = t.graph().toString()
    const history = t.w.UndoRedo.stack.slice()
    t.edit('unapplied draft')
    assert.strictEqual(t.w.newModel(), false)
    assert.strictEqual(t.w.loadExample(0), false)
    t.w.UndoRedo.undo()
    assert.equal(t.graph().toString(), editedGraph)
    assert.deepEqual(Array.from(t.w.UndoRedo.stack), Array.from(history), 'blocked Undo leaves history untouched')
    assert.equal(t.$('adj_matrix').value, 'unapplied draft')
    t.$('adj_matrix').value = editedGraph; t.w.modelCodeChanged(); t.w.UndoRedo.undo()
    const undone = t.graph().toString(), future = t.w.UndoRedo.future.slice()
    t.edit('another pending draft'); t.w.UndoRedo.redo()
    assert.equal(t.graph().toString(), undone)
    assert.deepEqual(Array.from(t.w.UndoRedo.future), Array.from(future), 'blocked Redo leaves history untouched')
    assert.ok(t.messages.some(message => /Apply or download/.test(message)))
    t.close()
})

QUnit.test('online loading refuses an existing draft and rechecks after a delayed response', async assert => {
    const t = await modelCodeFixture()
    let calls = 0, resolveResponse
    t.w.fetch = () => { calls++; return new Promise(resolve => { resolveResponse = resolve }) }
    const initial = t.graph()
    t.edit('existing draft')
    assert.strictEqual(await t.w.loadOnline('https://dagitty.net/mExample'), false)
    assert.equal(calls, 0, 'no request starts while code is pending')
    t.$('adj_matrix').value = initial.toString(); t.w.modelCodeChanged()
    const loading = t.w.loadOnline('https://dagitty.net/mExample')
    t.edit('typed while loading')
    resolveResponse({ ok: true, json: async () => ({ g: 'dag { Remote }' }) })
    await loading
    assert.strictEqual(t.graph(), initial)
    assert.equal(t.$('adj_matrix').value, 'typed while loading')
    assert.equal(t.closed(), 0, 'the guard does not close an unrelated editor dialog')
    t.close()
})

QUnit.test('direct and causal-odds selections safely reject unsupported mixed graphs', async assert => {
    const t = await modelCodeFixture()
    for (const code of [
        'pdag { E [exposure] O [outcome] E -- O }',
        'mag { E [exposure] O [outcome] E <-> O }',
        'pag { E [exposure] O [outcome] E @-> O }'
    ]) {
        const graph = t.w.GraphParser.parseGuess(code)
        t.controller.setGraph(graph)
        for (const kind of ['adj_direct', 'adj_causalodds']) {
            let error = null
            try { t.w.causalEffectEstimates(kind) } catch (e) { error = e }
            assert.strictEqual(error, null, graph.getType() + ' / ' + kind + ' does not throw')
            assert.equal(t.biasMode(), 'normal')
            assert.ok(/supported for DAGs|requires a DAG/.test(t.$('causal_effect').textContent))
        }
    }
    t.controller.setGraph(t.w.GraphParser.parseGuess('dag { E [exposure] O [outcome] S [selected] E -> O E -> S O -> S }'))
    t.w.causalEffectEstimates('adj_direct')
    assert.equal(t.biasMode(), 'normal')
    assert.ok(/without selection nodes/.test(t.$('causal_effect').textContent))
    t.close()
})
