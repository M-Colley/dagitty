/* Interaction regressions for the beginner builder. Each test has its own
 * document, so a cancelled draft cannot leak into another user's session. */
const wizardFs = require('fs')
const wizardPath = require('path')
const { JSDOM: WizardDOM } = require('jsdom')
const wizardEngine = require('../../jslib/dagitty-node.js')

function wizardFixture() {
    const dom = new WizardDOM('<!doctype html><button id="launch">Build</button><textarea id="adj_matrix">previous model</textarea>',
        { url: 'http://localhost/', runScripts: 'outside-only' })
    const w = dom.window
    w.GraphParser = wizardEngine.GraphParser
    let installed = null, loads = 0
    w.loadDAGFromTextData = function () {
        installed = w.GraphParser.parseGuess(w.document.getElementById('adj_matrix').value)
        loads++
    }
    w.eval(wizardFs.readFileSync(wizardPath.join(__dirname, '../../gui/js/dag-wizard.js'), 'utf8'))
    const $ = (id) => w.document.getElementById(id)
    const next = () => $('wiz-next').click()
    const back = () => $('wiz-back').click()
    const enter = (id, value) => { $(id).value = value }
    $('launch').focus()
    w.DagWizard.start()
    const roles = (exposure = 'Exposure', outcome = 'Outcome') => {
        next(); enter('wiz-exposure', exposure); next(); enter('wiz-outcome', outcome); next()
    }
    return { w, $, next, back, enter, roles, graph: () => installed, loads: () => loads,
        close: () => dom.window.close() }
}

QUnit.module('guided DAG builder')

QUnit.test('Back and reopening retain choices and a pending variable; Next never drops it', function (assert) {
    const t = wizardFixture()
    t.w.document.querySelector('[value="advanced"]').checked = true
    t.next(); t.back()
    assert.ok(t.w.document.querySelector('[value="advanced"]').checked, 'mode stays selected')
    t.roles()
    assert.equal(t.$('wiz-var-role').value, 'other', 'an unspecified variable is not assumed to be a confounder')
    t.enter('wiz-var-name', 'Age')
    t.next()
    assert.ok(t.$('wiz-var-name'), 'a typed but unadded variable keeps the user on this step')
    assert.ok(/Choose Add/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.$('wiz-close').click()
    assert.equal(t.w.document.activeElement.id, 'launch', 'focus returns to the launch control')
    t.w.DagWizard.start()
    assert.equal(t.$('wiz-var-name').value, 'Age', 'closing keeps the draft')
    t.back(); t.next()
    assert.equal(t.$('wiz-var-name').value, 'Age', 'Back also keeps the draft')
    t.close()
})

QUnit.test('duplicate names cannot merge variable roles or a selection node', function (assert) {
    const t = wizardFixture()
    t.roles()
    t.enter('wiz-var-name', 'Age'); t.$('wiz-add-var').click()
    t.back(); t.enter('wiz-outcome', 'Age'); t.next()
    assert.ok(t.$('wiz-outcome'), 'outcome cannot reuse another variable name')
    t.enter('wiz-outcome', 'Outcome'); t.next(); t.next()
    t.$('wiz-sel-enabled').checked = true
    t.enter('wiz-sel-name', 'Exposure'); t.next()
    assert.ok(t.$('wiz-sel-name'), 'selection cannot reuse exposure name')
    assert.ok(/already in use/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.close()
})

QUnit.test('unsupported engine names and backslashes get a readable error before the model is replaced', function (assert) {
    const t = wizardFixture()
    t.next()
    t.enter('wiz-exposure', '__proto__'); t.next()
    assert.ok(/reserved/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.enter('wiz-exposure', 'graph'); t.next()
    assert.ok(/reserved/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.enter('wiz-exposure', 'Risk\\group'); t.next()
    assert.ok(/backslashes/.test(t.w.document.querySelector('[role="alert"]').textContent))
    assert.equal(t.loads(), 0)
    assert.equal(t.$('adj_matrix').value, 'previous model')
    t.close()
})

QUnit.test('reviewed role suggestions preserve measured status, selection causes, and quoted names', function (assert) {
    const t = wizardFixture()
    t.roles('Hours "online" {daily}', 'Recovery')
    t.enter('wiz-var-name', 'Prior health')
    t.$('wiz-var-role').value = 'confounder'
    t.$('wiz-var-measured').checked = false
    t.$('wiz-add-var').click()
    t.enter('wiz-var-name', 'Context'); t.$('wiz-add-var').click()
    t.next()
    t.$('wiz-sel-enabled').checked = true
    Array.from(t.$('wiz-sel-causes').querySelectorAll('input')).find(cb => cb.dataset.cause === 'Prior health').checked = true
    t.next()
    const review = t.$('wiz-body').textContent
    assert.ok(/starting assumptions, not findings from data/.test(review))
    assert.ok(/Prior health → Selected/.test(review), 'suggested arrows can be inspected before creating')
    t.$('wiz-tour').checked = false
    t.next()
    const g = t.graph()
    assert.ok(g.getVertex('Hours "online" {daily}'), 'name is escaped, not silently rewritten')
    assert.ok(g.isLatentNode(g.getVertex('Prior health')), 'unmeasured remains latent')
    assert.ok(g.isSelectedNode(g.getVertex('Selected')), 'selection role is retained')
    assert.equal(g.getEdges().length, 4, 'only the declared templates and selection cause produce arrows')
    assert.equal(g.getAdjustedNodes().length, 0, 'measured variables are not automatically adjusted for')
    assert.equal(t.loads(), 1)
    assert.equal(t.$('wiz-modal').style.display, 'none')
    t.close()
})

QUnit.test('renaming an exposure removes stale selection arrows rather than creating a ghost variable', function (assert) {
    const t = wizardFixture()
    t.roles(); t.next()
    t.$('wiz-sel-enabled').checked = true
    t.$('wiz-sel-causes').querySelector('input').checked = true
    t.next(); t.back(); t.back(); t.back(); t.back()
    t.enter('wiz-exposure', 'Treatment'); t.next(); t.next(); t.next(); t.next()
    assert.notOk(/Exposure → Selected/.test(t.$('wiz-body').textContent))
    t.$('wiz-tour').checked = false; t.next()
    assert.notOk(t.graph().getVertex('Exposure'), 'a stale checkbox cannot add the old exposure to the graph')
    t.close()
})

QUnit.test('unapplied model code and failed creation retain the previous code and builder draft', function (assert) {
    const t = wizardFixture()
    t.roles(); t.next(); t.next()
    t.$('wiz-tour').checked = false
    t.$('adj_matrix').classList.add('dirty')
    t.next()
    assert.equal(t.loads(), 0, 'unapplied code is not replaced')
    assert.equal(t.$('adj_matrix').value, 'previous model')
    assert.ok(/unapplied changes/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.$('adj_matrix').classList.remove('dirty')
    t.w.loadDAGFromTextData = () => { throw new Error('unavailable') }
    t.next()
    assert.equal(t.$('adj_matrix').value, 'previous model', 'failure restores previous code')
    assert.equal(t.$('wiz-modal').style.display, 'flex', 'failure keeps the builder open')
    assert.ok(/could not be created/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.close()
})

QUnit.test('editing a variable changes its graph assumptions and preserves its selection arrow', function (assert) {
    const t = wizardFixture()
    t.roles()
    t.enter('wiz-var-name', 'Age')
    t.$('wiz-var-role').value = 'confounder'
    t.$('wiz-add-var').click()
    t.next()
    t.$('wiz-sel-enabled').checked = true
    Array.from(t.$('wiz-sel-causes').querySelectorAll('input')).find(cb => cb.dataset.cause === 'Age').checked = true
    t.next(); t.back(); t.back()
    t.enter('wiz-var-name', 'Context')
    t.$('wiz-var-role').value = 'collider'
    t.$('wiz-var-list').querySelector('[data-action="edit"]').click()
    t.enter('wiz-var-name', 'Prior health')
    t.$('wiz-var-role').value = 'mediator'
    t.$('wiz-var-measured').checked = false
    t.$('wiz-add-var').click()
    assert.equal(t.$('wiz-var-name').value, 'Context', 'editing preserves a pending addition')
    assert.equal(t.$('wiz-var-role').value, 'collider')
    assert.ok(/Prior health/.test(t.$('wiz-var-list').textContent))
    t.$('wiz-add-var').click()
    t.next()
    const renamedCause = Array.from(t.$('wiz-sel-causes').querySelectorAll('input')).find(cb => cb.dataset.cause === 'Prior health')
    assert.true(renamedCause.checked, 'selection still depends on the renamed variable')
    t.next()
    t.$('wiz-tour').checked = false
    t.next()
    const g = t.graph()
    assert.notOk(g.getVertex('Age'), 'rename does not leave a ghost variable')
    assert.ok(g.isLatentNode(g.getVertex('Prior health')), 'measurement changes reach the created graph')
    const edges = g.getEdges().map(e => e.v1.id + ' -> ' + e.v2.id)
    assert.ok(edges.includes('Exposure -> Prior health'), 'the edited mediator role changes the suggested arrows')
    assert.ok(edges.includes('Prior health -> Outcome'))
    assert.ok(edges.includes('Prior health -> Selected'))
    assert.notOk(edges.includes('Prior health -> Exposure'), 'the old confounder arrows are removed')
    t.close()
})

QUnit.test('unfinished edits survive closing and Back, and invalid names cannot replace a variable', function (assert) {
    const t = wizardFixture()
    t.roles()
    t.enter('wiz-var-name', 'Age'); t.$('wiz-add-var').click()
    t.enter('wiz-var-name', 'Pending')
    t.$('wiz-var-list').querySelector('[data-action="edit"]').click()
    t.enter('wiz-var-name', 'Outcome'); t.$('wiz-add-var').click()
    assert.ok(/already in use/.test(t.w.document.querySelector('[role="alert"]').textContent))
    assert.ok(/Age/.test(t.$('wiz-var-list').textContent), 'an invalid edit leaves the saved row unchanged')
    t.enter('wiz-var-name', '__proto__'); t.$('wiz-add-var').click()
    assert.ok(/reserved/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.enter('wiz-var-name', 'Updated age')
    t.$('wiz-var-measured').checked = false
    t.next()
    assert.ok(/Save changes or Cancel edit/.test(t.w.document.querySelector('[role="alert"]').textContent))
    t.$('wiz-close').click(); t.w.DagWizard.start()
    assert.equal(t.$('wiz-var-name').value, 'Updated age')
    assert.false(t.$('wiz-var-measured').checked)
    t.back(); t.next()
    assert.equal(t.$('wiz-var-name').value, 'Updated age', 'Back retains the current edit')
    t.$('wiz-cancel-edit').click()
    assert.equal(t.$('wiz-var-name').value, 'Pending', 'Cancel returns to the unadded draft')
    assert.ok(/Age/.test(t.$('wiz-var-list').textContent), 'Cancel retains the original saved variable')
    t.close()
})

QUnit.test('removing another row during an edit keeps the edited row attached to its variable', function (assert) {
    const t = wizardFixture()
    t.roles()
    t.enter('wiz-var-name', 'First'); t.$('wiz-add-var').click()
    t.enter('wiz-var-name', 'Second'); t.$('wiz-add-var').click()
    t.$('wiz-var-list').querySelector('[aria-label="Edit Second"]').click()
    t.enter('wiz-var-name', 'Renamed')
    t.$('wiz-var-list').querySelector('[aria-label="Remove First"]').click()
    t.$('wiz-add-var').click()
    t.next(); t.next()
    t.$('wiz-tour').checked = false; t.next()
    assert.ok(t.graph().getVertex('Renamed'))
    assert.notOk(t.graph().getVertex('First'))
    assert.notOk(t.graph().getVertex('Second'))
    t.close()
})
