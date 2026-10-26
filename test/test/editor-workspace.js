const ewFs = require('fs')
const ewPath = require('path')
const { JSDOM: EditorDOM } = require('jsdom')
const ewEngine = require('../../jslib/dagitty-node.js')
const ewUnderscore = require('underscore')

async function editorWorkspaceFixture(code, modules = ['workspace.js', 'structured-editor.js']) {
    const dom = new EditorDOM('<!doctype html><button id="launch">Edit</button><textarea id="adj_matrix"></textarea>',
        { url: 'http://localhost/', runScripts: 'outside-only' })
    const w = dom.window, d = w.document, listeners = {}
    w._ = ewUnderscore
    w.Graph = ewEngine.Graph
    w.GraphParser = ewEngine.GraphParser
    w.GraphLayouter = ewEngine.GraphLayouter
    w.Model = { dag: w.GraphParser.parseGuess(code || 'dag { A [pos="0,0"] B [pos="1,0"] A -> B }') }
    const emit = event => (listeners[event] || []).forEach(fn => fn(w.Model.dag))
    const mutate = fn => { const result = fn(w.Model.dag); emit('graphchange'); return result }
    w.DAGittyControl = {
        observe: (event, fn) => { (listeners[event] || (listeners[event] = [])).push(fn) },
        setGraph: graph => { w.Model.dag = graph; d.getElementById('adj_matrix').value = graph.toString(); emit('graphchange') },
        newVertex: (name, x, y) => mutate(g => g.addVertex(new w.Graph.Vertex({ id: name, layout_pos_x: x, layout_pos_y: y }))),
        renameVertex: (a, b) => mutate(g => g.renameVertex(a, b)),
        deleteVertex: id => mutate(g => g.deleteVertex(id)),
        getObservedGraph: () => ({ addEdge: (a, b, type) => mutate(g => g.addEdge(a, b, type)),
            deleteEdge: (a, b, type) => mutate(g => g.deleteEdge(a, b, type)) })
    }
    w.displayShow = w.displayHide = function () {}
    d.getElementById('adj_matrix').value = w.Model.dag.toString()
    modules.forEach(file => w.eval(ewFs.readFileSync(ewPath.join(__dirname, '../../gui/js', file), 'utf8')))
    await new Promise(resolve => w.addEventListener('load', resolve, { once: true }))
    const $ = id => d.getElementById(id)
    const submit = id => $(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))
    const settle = () => new Promise(resolve => w.setTimeout(resolve, 65))
    return { w, d, $, submit, settle, emit, graph: () => w.Model.dag,
        saved: () => JSON.parse(w.localStorage.getItem('dagitty_autosave')),
        flush: () => w.dispatchEvent(new w.Event('pagehide')), close: () => w.close() }
}

QUnit.module('list editor and workspace interactions')

QUnit.test('list editor preserves quoted names and rejects unsupported engine names', async assert => {
    const t = await editorWorkspaceFixture()
    t.w.StructuredEditor.open()
    t.$('se-new-var').value = 'Hours "online" {daily}'
    t.submit('se-add-var')
    await t.settle()
    assert.ok(t.graph().getVertex('Hours "online" {daily}'), 'display names are preserved')
    t.$('se-new-var').value = '__proto__'
    t.submit('se-add-var')
    await t.settle()
    assert.ok(/reserved/.test(t.$('se-live').textContent))
    assert.equal(t.graph().getNumberOfVertices(), 3)
    t.$('se-new-var').value = 'node'; t.submit('se-add-var')
    await t.settle()
    assert.ok(/reserved/.test(t.$('se-live').textContent), 'DAGitty reserved identifiers cannot break exported code')
    assert.equal(t.graph().getNumberOfVertices(), 3)
    t.close()
})

QUnit.test('committing a rename with Tab keeps focus on the next role and commits once', async assert => {
    const t = await editorWorkspaceFixture()
    t.w.StructuredEditor.open()
    await t.settle()
    const name = Array.from(t.d.querySelectorAll('#se-vars input')).find(input => input.value === 'A')
    const role = name.closest('tr').querySelector('select')
    name.focus(); name.value = 'Treatment "A"'; role.focus()
    await t.settle()
    assert.ok(t.graph().getVertex('Treatment "A"'))
    assert.equal(t.d.activeElement.dataset.focus, 'role:Treatment "A"', 'the scheduled table render retains Tab focus')
    const renamed = Array.from(t.d.querySelectorAll('#se-vars input')).find(input => input.value === 'Treatment "A"')
    renamed.focus(); renamed.value = 'Treatment'
    renamed.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    renamed.blur()
    await t.settle()
    assert.ok(t.graph().getVertex('Treatment'))
    assert.notOk(/already exists/.test(t.$('se-live').textContent), 'blur after Enter does not repeat the old rename')
    t.close()
})

QUnit.test('list editor prevents directed cycles and can retain unresolved PDAG directions', async assert => {
    const t = await editorWorkspaceFixture('dag { A B C A -> B B -> C }')
    t.w.StructuredEditor.open()
    t.$('se-from').value = 'C'; t.$('se-to').value = 'A'; t.$('se-type').value = 'directed'
    t.submit('se-add-arrow')
    await t.settle()
    assert.equal(t.graph().getEdges().length, 2)
    assert.ok(/directed cycle/.test(t.$('se-live').textContent))
    t.w.DAGittyControl.setGraph(t.w.GraphParser.parseGuess('pdag { A B C A -- B }'))
    await t.settle()
    assert.ok(Array.from(t.$('se-type').options).some(o => o.value === 'undirected'))
    assert.notOk(Array.from(t.$('se-type').options).some(o => o.value === 'bidirected'), 'PDAG uncertainty is not represented as hidden confounding')
    t.$('se-from').value = 'B'; t.$('se-to').value = 'C'; t.$('se-type').value = 'undirected'
    t.submit('se-add-arrow')
    await t.settle()
    assert.ok(t.graph().getEdge('B', 'C', t.w.Graph.Edgetype.Undirected))
    t.close()
})

QUnit.test('diagram Undo and Redo are available inside the list editor', async assert => {
    const t = await editorWorkspaceFixture(undefined, ['ui-enhancements.js', 'workspace.js', 'structured-editor.js'])
    await t.settle(); await t.settle()
    t.w.StructuredEditor.open()
    t.$('se-new-var').value = 'Extra'; t.submit('se-add-var')
    await t.settle()
    assert.notOk(t.$('se-undo').disabled)
    t.$('se-undo').click()
    await t.settle()
    assert.notOk(t.graph().getVertex('Extra'), 'Undo changes the graph without closing the modal')
    assert.notOk(t.$('se-redo').disabled)
    t.$('se-redo').click()
    await t.settle()
    assert.ok(t.graph().getVertex('Extra'), 'Redo restores the graph inside the same editor')
    t.close()
})

QUnit.test('list editing and model imports protect unapplied model code', async assert => {
    const t = await editorWorkspaceFixture()
    t.$('adj_matrix').value = 'unfinished draft'; t.$('adj_matrix').classList.add('dirty')
    t.w.StructuredEditor.open()
    assert.notOk(t.$('se-modal'), 'the list editor cannot overwrite the draft through graph changes')
    assert.equal(t.d.activeElement.id, 'adj_matrix')
    t.w.FileReader = class { readAsText() { this.onload({ target: { result: 'dag { Other }' } }) } }
    t.w.Workspace.openFile()
    const file = t.d.querySelector('input[type="file"]')
    Object.defineProperty(file, 'files', { value: [{ name: 'other.dag' }], configurable: true })
    file.dispatchEvent(new t.w.Event('change'))
    assert.equal(t.$('adj_matrix').value, 'unfinished draft')
    assert.ok(t.graph().getVertex('A'))
    assert.ok(/unapplied changes/.test(t.$('app-toast').textContent))
    t.w.Workspace.shareLink()
    assert.equal(t.w.location.hash, '', 'a link cannot silently share the diagram before unapplied edits')
    t.close()
})

QUnit.test('layout edits invalidate share links and survive closing the page', async assert => {
    const t = await editorWorkspaceFixture()
    t.w.Workspace.shareLink()
    assert.ok(t.w.location.hash.startsWith('#dag='))
    t.graph().getVertex('A').layout_pos_y = 2
    t.emit('graphlayoutchange')
    assert.equal(t.w.location.hash, '', 'the old link cannot replace the edited layout on reload')
    t.flush()
    assert.equal(t.saved().code, t.graph().toString(), 'pagehide flushes the pending layout save')
    t.close()
})

QUnit.test('Undo back to the initial graph replaces the previously autosaved edit', async assert => {
    const t = await editorWorkspaceFixture()
    const initial = t.graph().toString()
    t.w.DAGittyControl.newVertex('Extra', 2, 2); t.flush()
    assert.ok(t.saved().code.includes('Extra'))
    t.w.DAGittyControl.setGraph(t.w.GraphParser.parseGuess(initial)); t.flush()
    assert.equal(t.saved().code, initial, 'reload restores the graph after Undo, including the initial graph')
    t.close()
})

QUnit.test('only the latest asynchronously opened model file may replace the graph', async assert => {
    const t = await editorWorkspaceFixture()
    const reads = []
    t.w.FileReader = class { constructor() { reads.push(this) } readAsText() {} }
    t.w.Workspace.openFile()
    const input = t.d.querySelector('input[type="file"]')
    for (const name of ['old.dag', 'new.dag']) {
        Object.defineProperty(input, 'files', { value: [{ name }], configurable: true })
        input.dispatchEvent(new t.w.Event('change'))
    }
    reads[1].onload({ target: { result: 'dag { New [pos="0,0"] }' } })
    reads[0].onload({ target: { result: 'dag { Old [pos="0,0"] }' } })
    assert.ok(t.graph().getVertex('New'))
    assert.notOk(t.graph().getVertex('Old'))
    t.close()
})
