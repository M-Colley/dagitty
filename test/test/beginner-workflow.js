const beginnerFs = require('fs')
const beginnerPath = require('path')
const { JSDOM: BeginnerDOM } = require('jsdom')

async function beginnerFixture(code, options = {}) {
    const gui = beginnerPath.join(__dirname, '../../gui')
    const dom = new BeginnerDOM(beginnerFs.readFileSync(beginnerPath.join(gui, 'dags.html'), 'utf8'),
        { url: 'http://localhost/', runScripts: 'outside-only' })
    const w = dom.window, d = w.document, observers = {}
    const script = file => w.eval(beginnerFs.readFileSync(beginnerPath.join(gui, 'js', file), 'utf8'))
    if (options.storageFailure) Object.defineProperty(w, 'localStorage', { get() { throw new Error('Unavailable') } })
    else if (options.saved !== undefined) w.localStorage.setItem('dagitty_beginner_mode', options.saved)
    if (options.advancedEffect) w.localStorage.setItem('dagitty_advanced_effect', options.advancedEffect)
    if (options.autosave) w.localStorage.setItem('dagitty_autosave', JSON.stringify({ code: options.autosave, ts: Date.now() }))
    script('dagitty.js'); script('styles/original.js'); script('example-dags.js'); script('main.js')
    w.eval(Array.from(d.scripts).find(s => s.textContent.includes('function initialize()')).textContent)
    let graph = w.GraphParser.parseGuess(code)
    const emit = () => (observers.graphchange || []).forEach(fn => fn(graph))
    const view = { resize() {}, closeDialog() {}, getImplementation: () => ({ stopMousemove() {} }) }
    const controller = {
        observe(event, fn) { (observers[event] || (observers[event] = [])).push(fn) },
        setGraph(next) { graph = next; emit() }, graphChanged: emit, getGraph: () => graph,
        getView: () => view, redraw() {}, setBiasMode() {}, setViewMode() {}
    }
    w.DAGitty.setup = () => { w.DAGitty.controllers = [controller] }
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent }, set(value) { this.textContent = value }
    })
    for (const file of ['ui-enhancements.js', 'diagram-check.js', 'methods-export.js', 'report-export.js', 'beginner-workflow.js']) script(file)
    if (options.autosave) script('workspace.js')
    if (options.tour) script('guided-tour.js')
    if (options.kind) d.getElementById('causal_effect_kind').value = options.kind
    await new Promise(resolve => w.addEventListener('load', resolve, { once: true }))
    return { w, d, $: id => d.getElementById(id), graph: () => graph, set: controller.setGraph,
        close: () => w.close() }
}

const beginnerConfounded = 'dag { E [exposure,pos="0,0"] Y [outcome,pos="2,0"] C [pos="1,-1"] M [adjusted,pos="1,0"] C -> E C -> Y E -> M M -> Y }'

QUnit.module('guided beginner workspace')

QUnit.test('first visits start guided, explicit advanced preference survives, and storage failures permit toggling', async assert => {
    const first = await beginnerFixture(beginnerConfounded)
    assert.true(first.w.BeginnerMode.active)
    assert.ok(first.$('beginner-cause'))
    assert.equal(first.$('causal_effect_kind').value, 'adj_total')
    assert.ok(first.$('analysis_setup').classList.contains('advanced-only'))
    first.close()
    const saved = await beginnerFixture(beginnerConfounded, { saved: 'false' })
    assert.false(saved.w.BeginnerMode.active)
    saved.close()
    const unavailable = await beginnerFixture(beginnerConfounded, { storageFailure: true })
    assert.true(unavailable.w.BeginnerMode.active)
    unavailable.$('beginner-full').click()
    assert.false(unavailable.w.BeginnerMode.active)
    assert.strictEqual(unavailable.d.activeElement, unavailable.$('btn-beginner-mode'))
    unavailable.close()
})

QUnit.test('mode changes force total effect, restore advanced analysis, and preserve graph and drafts', async assert => {
    const t = await beginnerFixture(beginnerConfounded, { saved: 'false', kind: 'adj_direct' })
    const before = t.graph().toString()
    t.$('adj_matrix').value = 'my unfinished model code'
    t.$('adj_matrix').classList.add('dirty')
    t.w.BeginnerMode.toggle()
    assert.equal(t.$('causal_effect_kind').value, 'adj_total')
    assert.equal(t.w.ReportExport.collect().adjustment.criterion, 'total effect')
    assert.ok(t.w.MethodsExport.generate().includes('total effect'))
    assert.equal(t.graph().toString(), before)
    assert.equal(t.$('adj_matrix').value, 'my unfinished model code')
    assert.false(t.$('beginner-draft').hidden)
    t.w.BeginnerMode.toggle()
    assert.equal(t.$('causal_effect_kind').value, 'adj_direct')
    assert.equal(t.w.ReportExport.collect().adjustment.criterion, 'direct effect')
    assert.equal(t.graph().toString(), before)
    assert.equal(t.$('adj_matrix').value, 'my unfinished model code')
    t.close()
})

QUnit.test('applying a complete recommended set replaces controls in one undo step and preserves arrows and positions', async assert => {
    const t = await beginnerFixture(beginnerConfounded)
    const before = t.graph().toString()
    assert.ok(t.$('beginner-options').textContent.includes('C'))
    const apply = t.$('beginner-options').querySelector('button')
    apply.focus()
    apply.click()
    assert.deepEqual(Array.from(t.graph().getAdjustedNodes(), v => v.id), ['C'])
    assert.equal(t.graph().getEdges().length, 4)
    assert.equal(t.graph().getVertex('C').layout_pos_y, -1)
    assert.ok(t.$('beginner-verdict').textContent.includes('are sufficient'))
    assert.strictEqual(t.d.activeElement, t.$('beginner-verdict'), 'keyboard focus moves to the updated result')
    t.w.UndoRedo.undo()
    assert.equal(t.graph().toString(), before)
    t.w.UndoRedo.redo()
    assert.deepEqual(Array.from(t.graph().getAdjustedNodes(), v => v.id), ['C'])
    t.close()
})

QUnit.test('an empty valid set explicitly clears controls and latent or selection nodes are never offered as controls', async assert => {
    const t = await beginnerFixture('dag { E [exposure] Y [outcome] M [adjusted] S [selected] U [latent] E -> M M -> Y }')
    assert.ok(t.$('beginner-explanation').textContent.includes('No additional controls'))
    assert.ok(t.$('beginner-options').textContent.includes('Use no controls'))
    const variables = Array.from(t.$('beginner-controls').querySelectorAll('input'), e => e.dataset.variable)
    assert.deepEqual(variables, ['M'])
    assert.false(t.w.BeginnerGuide.applySet(['S']))
    assert.false(t.w.BeginnerGuide.applySet(['U']))
    assert.true(t.w.BeginnerGuide.applySet([]))
    assert.equal(t.graph().getAdjustedNodes().length, 0)
    assert.ok(t.graph().isSelectedNode('S'))
    assert.ok(t.graph().isLatentNode('U'))
    t.close()
})

QUnit.test('pending code and stale or insufficient suggestions cannot change the live model', async assert => {
    const t = await beginnerFixture(beginnerConfounded)
    const before = t.graph().toString()
    t.$('adj_matrix').value = 'unapplied draft'
    t.$('adj_matrix').classList.add('dirty')
    t.w.BeginnerGuide.refresh()
    assert.true(t.$('beginner-options').querySelector('button').disabled)
    assert.false(t.w.BeginnerGuide.applySet(['C']))
    assert.equal(t.graph().toString(), before)
    assert.equal(t.$('adj_matrix').value, 'unapplied draft')
    t.$('adj_matrix').classList.remove('dirty')
    assert.false(t.w.BeginnerGuide.applySet(['M']))
    assert.equal(t.graph().toString(), before)
    assert.ok(t.$('beginner-notice').textContent.includes('no longer sufficient'))
    t.close()
})

QUnit.test('no-set, uncertain, cyclic and joint-effect models receive explanations without misleading suggestions', async assert => {
    const t = await beginnerFixture('dag { E [exposure] Y [outcome] U [latent] U -> E U -> Y E -> Y }')
    assert.ok(t.$('beginner-explanation').textContent.includes('No set of measured controls'))
    assert.equal(t.$('beginner-options').querySelectorAll('button').length, 0)
    t.set(t.w.GraphParser.parseGuess('pdag { E [exposure] Y [outcome] E -- Y }'))
    assert.ok(t.$('beginner-verdict').textContent.includes('full editor'))
    assert.equal(t.$('beginner-options').querySelectorAll('button').length, 0)
    t.set(t.w.GraphParser.parseGuess('dag { E [exposure] Y [outcome] E -> Y Y -> E }'))
    assert.ok(t.$('beginner-verdict').textContent.includes('loop'))
    t.set(t.w.GraphParser.parseGuess('dag { E [exposure] X [exposure] Y [outcome] E -> Y X -> Y }'))
    assert.ok(t.$('beginner-explanation').textContent.includes('joint effects'))
    assert.equal(t.graph().getSources().length, 2, 'rendering never silently discards a role')
    t.close()
})

QUnit.test('plain question selectors update roles explicitly, retain literal names, and reject using one variable for both roles', async assert => {
    const t = await beginnerFixture('dag { E [exposure] Y [outcome] "A < B" "A < B" -> E E -> Y }')
    const cause = t.$('beginner-cause')
    cause.value = 'A < B'
    cause.dispatchEvent(new t.w.Event('change', { bubbles: true }))
    assert.deepEqual(Array.from(t.graph().getSources(), v => v.id), ['A < B'])
    assert.ok(t.$('beginner-question').textContent.includes('A < B'))
    assert.equal(t.$('beginner-question').querySelectorAll('*').length, 0)
    cause.value = 'Y'
    cause.dispatchEvent(new t.w.Event('change', { bubbles: true }))
    assert.deepEqual(Array.from(t.graph().getSources(), v => v.id), ['A < B'])
    assert.ok(t.$('beginner-notice').textContent.includes('two different'))
    t.close()
})

QUnit.test("a saved advanced effect survives a reload into beginner mode", async assert => {
    const t = await beginnerFixture(beginnerConfounded, { saved: "true", advancedEffect: "adj_direct" })
    assert.equal(t.$("causal_effect_kind").value, "adj_total")
    t.w.BeginnerMode.toggle()
    assert.equal(t.$("causal_effect_kind").value, "adj_direct")
    t.close()
})

QUnit.test('advanced mode restores the saved strategy for the autosaved diagram', async assert => {
    const t = await beginnerFixture(beginnerConfounded, {
        saved: 'false', advancedEffect: 'adj_causalodds',
        autosave: 'dag { E [exposure,pos="0,0"] Y [outcome,pos="2,0"] S [selected,pos="2,1"] E -> Y Y -> S }'
    })
    await new Promise(resolve => t.w.setTimeout(resolve, 0))
    assert.ok(t.graph().isSelectedNode('S'), 'the restored graph supports the causal odds ratio')
    assert.equal(t.$('causal_effect_kind').value, 'adj_causalodds')
    assert.equal(t.w.ReportExport.collect().adjustment.criterion, 'causal odds ratio')
    t.close()
})

QUnit.test('imported conflicting roles cannot produce a positive guided adjustment verdict', async assert => {
    const t = await beginnerFixture('dag { E [exposure,adjusted] Y [outcome] C C -> E C -> Y E -> Y }')
    assert.ok(/cannot be used as controls.*E/.test(t.$('beginner-verdict').textContent))
    const replacement = t.$('beginner-options').querySelector('button')
    assert.ok(replacement, 'offer the measured replacement')
    replacement.click()
    assert.deepEqual(Array.from(t.graph().getAdjustedNodes(), v => v.id), ['C'])
    t.set(t.w.GraphParser.parseGuess('dag { E [exposure,latent] Y [outcome] E -> Y }'))
    assert.ok(/measured cause and result/.test(t.$('beginner-verdict').textContent))
    assert.notOk(t.$('beginner-options').querySelector('button'))
    t.close()
})

QUnit.test('the tour follows the visible beginner workflow and still offers advanced guidance', async assert => {
    const t = await beginnerFixture(beginnerConfounded, { tour: true })
    t.w.GuidedTour.start()
    assert.strictEqual(t.d.activeElement, t.$('tour-next'))
    const titles = []
    for (let i = 0; i < 5; i++) {
        titles.push(t.$('tour-title').textContent)
        t.$('tour-next').click()
    }
    assert.deepEqual(titles, ['Choose your question', 'Review your assumptions', 'Choose your controls',
        'Save and discuss', 'Explore the full editor'])
    assert.false(t.$('tour-root').classList.contains('on'))
    t.w.BeginnerMode.toggle()
    t.w.GuidedTour.start()
    for (let i = 0; i < 5; i++) t.$('tour-next').click()
    assert.equal(t.$('tour-title').textContent, 'Predictions you can test')
    t.close()
})
