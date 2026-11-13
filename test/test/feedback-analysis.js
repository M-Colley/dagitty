/* Exercise adjustment advice and finding disclosures using the real renderer. */
const feedbackFs = require('fs')
const feedbackPath = require('path')
const { JSDOM: FeedbackDOM } = require('jsdom')
const feedbackEngine = require('../../jslib/dagitty-node.js')

async function feedbackFixture(code) {
    const dom = new FeedbackDOM('<!doctype html><div id="causal_effect"></div>' +
        '<div id="diagram_check"></div><span id="dcheck_count"></span>' +
        '<select id="causal_effect_kind"><option value="adj_total">total</option>' +
        '<option value="adj_direct">direct</option><option value="adj_causalodds">odds</option></select>',
        { url: 'http://localhost/', runScripts: 'outside-only' })
    const w = dom.window
    Object.assign(w, feedbackEngine, { _: require('underscore'), Model: { dag: feedbackEngine.GraphParser.parseGuess(code) }, DAGittyControl: null })
    // jsdom does not implement innerText's rendering behavior. Mirror the text
    // setter so the UI's real plain-language rewrite sees main.js's output.
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent }, set(value) { this.textContent = value }
    })
    for (const file of ['main.js', 'ui-enhancements.js', 'diagram-check.js', 'methods-export.js', 'report-export.js']) {
        w.eval(feedbackFs.readFileSync(feedbackPath.join(__dirname, '../../gui/js', file), 'utf8'))
    }
    await new Promise(resolve => w.addEventListener('load', resolve, { once: true }))
    return { w, d: w.document, close: () => w.close() }
}

QUnit.module('reviewer feedback: analysis guidance')

QUnit.test('an invalid mediator adjustment gets one complete replacement immediately after the verdict', async assert => {
    const t = await feedbackFixture('dag { E [exposure] Y [outcome] M [adjusted] C C -> E C -> Y E -> M M -> Y }')
    t.w.displayAdjustmentInfo('total')
    const verdict = t.d.querySelector('#causal_effect .warning')
    const advice = verdict.nextElementSibling
    assert.ok(/not sufficient/.test(verdict.textContent))
    assert.ok(advice.classList.contains('adj-alt'), 'the solution is next to the warning')
    assert.ok(/Replace your chosen controls with one complete set/.test(advice.textContent))
    assert.deepEqual(Array.from(advice.querySelectorAll('li'), li => li.textContent), ['C'])
    assert.equal(t.d.querySelectorAll('#causal_effect ul').length, 1, 'the constrained answer does not compete with the replacement')
    assert.ok(t.w.Model.dag.isAdjustedNode('M'), 'advice never silently edits the model')
    assert.notOk(t.w.Model.dag.isAdjustedNode('C'))
    t.close()
})

QUnit.test('a collider adjustment is told to clear controls instead of adding more', async assert => {
    const t = await feedbackFixture('dag { E [exposure] Y [outcome] A B Z [adjusted] A -> E A -> Z B -> Y B -> Z E -> Y }')
    t.w.displayAdjustmentInfo('total')
    const panel = t.d.getElementById('causal_effect')
    assert.ok(/Clear the Adjusted mark from Z/.test(panel.textContent))
    assert.ok(/without control variables under this diagram/.test(panel.textContent))
    assert.equal(panel.querySelectorAll('ul').length, 0, 'constrained supersets of the collider are removed')
    t.close()
})

QUnit.test('unadjusted confounding offers alternatives and measured latent-confounding failures are explicit', async assert => {
    const t = await feedbackFixture('dag { E [exposure] Y [outcome] A B A -> E A -> B B -> Y E -> Y }')
    t.w.displayAdjustmentInfo('total')
    const advice = t.d.querySelector('.adj-alt')
    assert.deepEqual(Array.from(advice.querySelectorAll('li'), li => li.textContent), ['A', 'B'])
    assert.ok(/rows are alternatives/.test(advice.textContent))
    t.w.Model.dag = t.w.GraphParser.parseGuess('dag { E [exposure] Y [outcome] U [latent] U -> E U -> Y E -> Y }')
    t.w.displayAdjustmentInfo('total')
    assert.ok(/No set of measured controls satisfies the total effect adjustment criterion/.test(t.d.querySelector('.adj-alt').textContent))
    assert.notOk(/may not be identifiable/.test(t.d.getElementById('causal_effect').textContent), 'the old generic failure is replaced')
    t.close()
})

QUnit.test('total-effect selection advice uses its criterion and unsupported kinds return no sets', async assert => {
    const t = await feedbackFixture('dag { E [exposure] Y [outcome] C S [selected] C -> E C -> Y E -> Y }')
    t.w.displayAdjustmentInfo('total')
    assert.deepEqual(Array.from(t.d.querySelectorAll('.adj-alt li'), li => li.textContent), ['C'])
    assert.strictEqual(t.w.AdjustmentSets.minimal(t.w.Model.dag, 'direct'), null)
    assert.strictEqual(t.w.AdjustmentSets.minimal(t.w.Model.dag, 'causalodds'), null)
    t.w.Model.dag = t.w.GraphParser.parseGuess('dag { E [exposure] Y [outcome] S [selected] E -> Y Y -> S }')
    t.w.displayAdjustmentInfo('total')
    assert.ok(/Review the selection mechanism/.test(t.d.querySelector('.adj-alt').textContent))
    t.w.Model.dag = t.w.GraphParser.parseGuess('graph { E [exposure] Y [outcome] E -- Y }')
    assert.strictEqual(t.w.AdjustmentSets.minimal(t.w.Model.dag, 'total'), null)
    t.w.causalEffectEstimates('adj_total')
    assert.ok(/Review the graph type/.test(t.d.getElementById('causal_effect').textContent))
    t.close()
})

QUnit.test('long findings collapse without losing their explanation or exported text', async assert => {
    const t = await feedbackFixture('dag { E [exposure] Y [outcome] S [selected] E -> Y E -> S Y -> S }')
    t.w.DiagramCheck.refresh()
    const full = t.w.DiagramCheck.analyse().find(f => f.subject === 'S')
    const details = t.d.querySelector('.dcheck-details')
    assert.ok(details, 'the selection explanation uses a native disclosure')
    assert.false(details.open)
    assert.ok(/Show more/.test(details.querySelector('summary').textContent))
    assert.ok(details.querySelector('.dcheck-explanation').textContent.includes('selection bias'))
    details.open = true
    details.dispatchEvent(new t.w.Event('toggle'))
    assert.ok(/Show less/.test(details.querySelector('summary').textContent))
    t.w.DiagramCheck.refresh()
    assert.true(t.d.querySelector('.dcheck-details').open, 'refresh retains the reader\'s expanded finding')
    assert.ok(t.w.ReportExport.collect().diagramCheck.some(f => f.text === full.subject + full.text), 'the report retains the complete finding')
    t.w.Model.dag = t.w.GraphParser.parseGuess('dag { E [exposure] Y [outcome] E -> Y }')
    t.w.DiagramCheck.refresh()
    assert.equal(t.d.querySelectorAll('.dcheck-details').length, 0, 'short findings remain immediately visible')
    t.close()
})

QUnit.test('unsupported total-effect graphs export an unavailable result without throwing or making an identification claim', async assert => {
    const t = await feedbackFixture('graph { E [exposure] Y [outcome] E -- Y }')
    const statement = t.w.MethodsExport.generate()
    assert.ok(/supports total-effect adjustment analysis for DAGs, PDAGs, MAGs and PAGs only/.test(statement))
    assert.ok(/No identification claim is made/.test(statement))
    const report = t.w.ReportExport.collect()
    assert.strictEqual(report.adjustment.supported, false)
    assert.strictEqual(report.adjustment.sufficient, null)
    assert.strictEqual(report.adjustment.minimalSets, null)
    assert.ok(/not supported for the chosen strategy/.test(t.w.ReportExport.buildHTML(report, '')))
    t.w.Model.dag = t.w.GraphParser.parseGuess('dag { E [exposure] Y [outcome] C C -> E C -> Y E -> Y }')
    const supported = t.w.ReportExport.collect()
    assert.strictEqual(supported.adjustment.supported, true)
    assert.deepEqual(Array.from(supported.adjustment.minimalSets, s => Array.from(s)), [['C']])
    assert.ok(/Minimal sufficient adjustment/.test(t.w.MethodsExport.generate()), 'supported total-effect reports keep their ordinary advice')
    t.close()
})
