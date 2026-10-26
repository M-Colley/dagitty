/* Screen fitting must keep readable labels inside narrow canvases without
 * changing the model geometry that is shared and exported. */
const fitFs = require('fs')
const fitPath = require('path')
const fitVm = require('vm')
const fitDagitty = require('../../jslib/dagitty-node.js')

function fittedView(g, width, options = {}) {
    const svg = {
        appendChild: el => { el.parentNode = svg },
        removeChild: el => { el.parentNode = null }
    }
    const context = fitVm.createContext({
        Class: { extend: definition => definition },
        document: {
            createElementNS: () => ({ setAttribute() {} }),
            createElement: () => ({ getContext: () => options.noMetrics ? null : {
                measureText: text => ({ width: text.length * 7.25 })
            } })
        },
        getComputedStyle: () => ({ font: '600 13px Arial', fontSize: '13px' })
    })
    const source = fitFs.readFileSync(fitPath.join(__dirname, '../../jslib/gui/GraphGUI_View.js'), 'utf8')
    fitVm.runInContext(source, context)
    const view = Object.create(context.DAGittyGraphView)
    view.width = width; view.height = 300
    view.impl = { svg, resize() {} }
    view.setCoordinateSystemValid(false)
    view.initializeCoordinateSystem(g)
    return view
}

function assertLabelsInside(assert, g, view, message) {
    g.getVertices().forEach(v => {
        const x = view.toScreenCoordinate(v.layout_pos_x, v.layout_pos_y)[0]
        const half = v.id.length * 7.25 / 2
        assert.ok(x - half >= 7.99 && x + half <= view.width - 7.99, message + ': ' + v.id)
    })
}

function fitGraph(bounds = true) {
    return fitDagitty.GraphParser.parseGuess('dag { ' + (bounds ? 'bb="0,0,1,1" ' : '') +
        '"Baseline wellbeing" [pos="0,0.2"] "Mental wellbeing" [pos="1,0.8"] ' +
        '"Baseline wellbeing" -> "Mental wellbeing" }')
}

QUnit.module('canvas label fitting')

QUnit.test('explicit model bounds fit labels initially and after a mobile resize', assert => {
    const g = fitGraph(), original = g.toString(), originalBounds = g.getBoundingBox().slice()
    const view = fittedView(g, 375)
    assertLabelsInside(assert, g, view, 'initial phone canvas')
    const container = { offsetWidth: 324, offsetHeight: 304 }
    view.getContainer = () => container
    view.drawGraph = function () { this.initializeCoordinateSystem(g) }
    view.resize()
    assert.equal(view.width, 320, 'the normal resize path recalculates the screen transform')
    assertLabelsInside(assert, g, view, 'narrower phone canvas')
    assert.equal(g.toString(), original, 'model coordinates and exported code stay unchanged')
    assert.deepEqual(g.getBoundingBox(), originalBounds, 'the explicit model bounding box is unchanged')
    assert.deepEqual(Array.from(view.bounds).slice(2), [0, 1], 'vertical framing is preserved')
})

QUnit.test('graphs without bounds also leave room for measured labels', assert => {
    const g = fitGraph(false), original = g.toString()
    const view = fittedView(g, 375)
    assertLabelsInside(assert, g, view, 'automatic bounds')
    assert.equal(g.toString(), original)
    assert.strictEqual(g.getBoundingBox(), null, 'view fitting does not add a model bounding box')
})

QUnit.test('broader explicit bounds retain the author\'s framing', assert => {
    const g = fitGraph()
    g.setBoundingBox([-10, -5, 10, 5])
    const view = fittedView(g, 375)
    assert.deepEqual(Array.from(view.bounds), [-10, 10, -5, 5], 'sufficient explicit margins are retained exactly')
})

QUnit.test('measurement fallback remains finite and keeps ordinary labels visible', assert => {
    const g = fitGraph(), view = fittedView(g, 320, { noMetrics: true })
    assertLabelsInside(assert, g, view, 'conservative fallback')
    assert.ok(Array.from(view.bounds).every(Number.isFinite))
    g.getVertices()[0].id = 'A label that is much wider than a tiny viewport can display in full'
    view.width = 120
    view.setCoordinateSystemValid(false)
    view.initializeCoordinateSystem(g)
    assert.ok(Array.from(view.bounds).every(Number.isFinite), 'oversize individual labels do not create an infinite transform')
})

QUnit.test('the deployed GUI contains the same view-fitting method as the source', assert => {
    const pattern = /\tinitializeCoordinateSystem : function\( g \)\{[\s\S]*?(?=\ttoScreenCoordinate : function)/
    const read = name => fitFs.readFileSync(fitPath.join(__dirname, '../../', name), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(read('gui/js/dagitty.js').match(pattern)[0], read('jslib/gui/GraphGUI_View.js').match(pattern)[0])
})
