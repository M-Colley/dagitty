const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')
const interactionDagitty = require('../../jslib/dagitty-node.js')

async function ui(options = {}) {
    const dom = new JSDOM('<!doctype html><html><body>' +
        '<button id="opener">Open</button><button id="btn-theme"></button>' +
        '<span id="btn-theme-label"></span><span id="btn-theme-icon"></span>' +
        '<button id="btn-beginner-mode"></button>' +
        '<h3 onclick="window.collapsed = true"><span class="help-tip" title="What this means">?</span></h3>' +
        '<div id="data-discovery-modal" role="dialog" aria-modal="true" style="display:none">' +
        '<button class="modal-close">Close</button><input id="data-csv-input">' +
        '<select id="data-alpha"><option value="0.05">0.05</option></select>' +
        '<select id="data-speed"><option value="standard">standard</option></select>' +
        '<input type="checkbox" id="data-use-lingam"><div id="data-var-select"></div><div id="data-var-list"></div>' +
        '<div id="data-modal-status"></div><div id="data-modal-preview"><div id="data-modal-preview-content"></div></div>' +
        '<button id="btn-run-analysis"></button><button id="btn-import-dag"></button>' +
        '<button id="btn-download-model"></button><button id="btn-cancel-analysis"></button></div>' +
        '</body></html>', { url: 'http://localhost/', runScripts: 'outside-only' })
    const w = dom.window
    w.Model = { dag: null }
    w.Graph = interactionDagitty.Graph
    w.GraphParser = interactionDagitty.GraphParser
    w.displayShow = w.displayHide = function () {}
    w.HTMLElement.prototype.getClientRects = function () {
        return this.closest('[style*="display: none"], [style*="display:none"]') ? [] : [{}]
    }
    let change
    w.matchMedia = () => ({ matches: false, addEventListener: (_, fn) => { change = fn } })
    if (options.noStorage) Object.defineProperty(w, 'localStorage', { get: () => { throw new Error('Unavailable') } })
    if (options.discovery) w.eval(fs.readFileSync(path.join(__dirname, '../../gui/js/causal-discovery.js'), 'utf8'))
    w.eval(fs.readFileSync(path.join(__dirname, '../../gui/js/ui-enhancements.js'), 'utf8'))
    await new Promise(resolve => w.addEventListener('load', resolve, { once: true }))
    w.document.querySelector('.modal-close').onclick = () => w.DataModal.close()
    return { w, change: value => change({ matches: value }), close: () => w.close() }
}

QUnit.module('UI interaction regressions')

QUnit.test('storage failure does not disable beginner mode or tooltips', async assert => {
    const { w, close } = await ui({ noStorage: true })
    w.BeginnerMode.toggle()
    assert.true(w.document.body.classList.contains('beginner-mode'))
    const help = w.document.querySelector('.help-tip')
    assert.equal(help.tabIndex, 0)
    help.focus()
    help.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.notOk(w.collapsed, 'help activation does not collapse its section')
    const tip = w.document.getElementById(help.getAttribute('aria-describedby'))
    assert.equal(tip.textContent, 'What this means')
    help.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    assert.equal(tip.style.display, 'none', 'Escape dismisses the help')
    const dynamic = w.document.createElement('span')
    dynamic.className = 'help-tip'
    dynamic.title = 'New help'
    w.document.body.appendChild(dynamic)
    await Promise.resolve()
    assert.equal(dynamic.tabIndex, 0, 'newly created help is keyboard reachable')
    close()
})

QUnit.test('manual theme choice survives an OS theme change', async assert => {
    const { w, change, close } = await ui()
    change(true)
    assert.equal(w.ThemeToggle.current(), 'dark', 'follows OS until a choice is made')
    w.ThemeToggle.set('light')
    change(true)
    assert.equal(w.ThemeToggle.current(), 'light')
    assert.equal(w.document.getElementById('btn-theme').getAttribute('aria-label'), 'Switch to dark theme')
    close()
})

QUnit.test('dialogs wrap keyboard focus and return to their opener', async assert => {
    const { w, close } = await ui()
    const d = w.document, opener = d.getElementById('opener')
    opener.focus()
    w.DataModal.open()
    await Promise.resolve()
    const first = d.querySelector('.modal-close'), last = d.getElementById('btn-cancel-analysis')
    // Stop is hidden until an analysis runs, so make it visible for this check.
    last.style.display = ''
    first.focus()
    first.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    assert.strictEqual(d.activeElement, last)
    last.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    assert.strictEqual(d.activeElement, first)
    first.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Promise.resolve()
    assert.equal(d.getElementById('data-discovery-modal').style.display, 'none')
    assert.strictEqual(d.activeElement, opener)
    close()
})

QUnit.test('stopped discovery callbacks cannot restore an old result', async assert => {
    const { w, close } = await ui()
    let resolve
    w.CausalDiscovery = { discoverFromCSVAsync: () => new Promise(r => { resolve = r }) }
    w.DataModal._csvText = 'x,y\n1,2'
    w.DataModal.runAnalysis()
    assert.notEqual(w.document.getElementById('btn-cancel-analysis').style.display, 'none')
    w.DataModal.cancelAnalysis()
    resolve({ modelCode: 'dag { old }' })
    await Promise.resolve()
    await Promise.resolve()
    assert.strictEqual(w.DataModal._resultCode, null)
    assert.true(w.document.getElementById('btn-import-dag').disabled)
    assert.equal(w.document.getElementById('data-modal-status').textContent, 'Analysis cancelled.')
    close()
})

QUnit.test('R export preserves model text including quotes and backslashes', async assert => {
    const { w, close } = await ui()
    const code = 'dag { "Parent\'s income" [pos="1,2"]\n"C:\\study" [outcome]\n}'
    const r = w.RCodeExport.generate({ toString: () => code })
    assert.ok(r.includes("Parent\\'s income"))
    assert.ok(r.includes('C:\\\\study'))
    assert.ok(r.includes('[pos="1,2"]'))
    assert.ok(r.includes('library(dagitty)'))
    assert.ok(r.includes('localTests(g, data = your_data)'))
    close()
})

QUnit.test('Stop remains available when worker construction falls back to the main thread', async assert => {
    const { w, close } = await ui()
    w.Worker = function () { throw new Error('Worker blocked') }
    w.CausalDiscovery = { discoverFromCSVAsync: () => new Promise(() => {}) }
    w.DataModal._csvText = 'x,y\n1,2'
    w.DataModal.runAnalysis()
    assert.notEqual(w.document.getElementById('btn-cancel-analysis').style.display, 'none')
    w.DataModal.cancelAnalysis()
    assert.equal(w.document.getElementById('data-modal-status').textContent, 'Analysis cancelled.')
    close()
})

QUnit.test('closing a menu-opened dialog returns to the visible menu title', async assert => {
    const { w, close } = await ui()
    const d = w.document
    d.body.insertAdjacentHTML('beforeend', '<ul id="menu"><li><a href="#" aria-haspopup="true" id="title">Model</a>' +
        '<ul id="submenu"><li><a href="#" id="open-item">Explore</a></li></ul></li></ul>')
    d.getElementById('open-item').focus()
    w.DataModal.open()
    d.getElementById('submenu').style.display = 'none'
    await Promise.resolve()
    w.DataModal.close()
    await Promise.resolve()
    assert.strictEqual(d.activeElement, d.getElementById('title'))
    close()
})

QUnit.test('discovery import preserves unapplied and invalid model code', async assert => {
    const { w, close } = await ui()
    const ta = w.document.createElement('textarea')
    ta.id = 'adj_matrix'
    ta.value = 'my unsaved work'
    ta.classList.add('dirty')
    w.document.body.appendChild(ta)
    w.DataModal._resultCode = 'unsupported graph'
    let parsed = false
    w.GraphParser = { parseGuess: () => { parsed = true; throw new Error('Invalid model') } }
    w.DataModal.importDAG()
    assert.false(parsed, 'an unapplied draft is not replaced')
    assert.equal(ta.value, 'my unsaved work')
    ta.classList.remove('dirty')
    w.DataModal.importDAG()
    assert.true(parsed)
    assert.equal(ta.value, 'my unsaved work', 'failed parsing cannot mutate the code editor')
    assert.ok(w.document.getElementById('data-modal-status').textContent.includes('Could not import'))
    close()
})

QUnit.test('mode label and pressed state describe the current view', async assert => {
    const { w, close } = await ui()
    const button = w.document.getElementById('btn-beginner-mode')
    assert.equal(button.textContent, 'Advanced mode')
    assert.equal(button.getAttribute('aria-pressed'), 'false')
    w.BeginnerMode.toggle()
    assert.equal(button.textContent, 'Beginner mode')
    assert.equal(button.getAttribute('aria-pressed'), 'true')
    assert.ok(button.title.includes('Switch to advanced'))
    close()
})

QUnit.test('discovery preview reads edges rather than arrow-like variable names', async assert => {
    const { w, close } = await ui()
    w.DataModal._showPreview({
        modelCode: 'pdag { "A -> B" C "A -> B" -- C }',
        vars: ['A -> B', 'C'], corrMat: [[1, .7], [.7, 1]]
    })
    const edges = w.document.querySelectorAll('.modal-preview-edge')
    assert.equal(edges.length, 1)
    assert.equal(edges[0].firstChild.textContent, 'A -> B — C')
    assert.ok(edges[0].textContent.includes('|r| = 0.70'))
    w.DataModal._showPreview({ modelCode: 'dag { "A -> B" C }' })
    assert.equal(w.document.querySelectorAll('.modal-preview-edge').length, 0)
    assert.ok(w.document.getElementById('data-modal-preview-content').textContent.includes('No connections retained'))
    close()
})

QUnit.test('discovery lets users exclude a problematic column before validation', async assert => {
    const { w, close } = await ui({ discovery: true })
    w.DataModal._csvText = 'x,y,node\n1,2,1\n2,4,2\n3,5,NA\n4,7,NA\n5,8,NA\n6,9,NA\n7,11,3'
    w.DataModal._onCsvReady('study.csv', 7)
    assert.equal(w.document.querySelectorAll('#data-var-list input').length, 3, 'all numeric choices appear')
    assert.false(w.document.getElementById('btn-run-analysis').disabled, 'validation waits until the user selects columns')
    assert.ok(w.document.getElementById('data-modal-status').textContent.includes('Adjust selection'))
    close()
})
