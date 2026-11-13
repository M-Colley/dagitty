const feedbackLayoutFs = require('fs')
const feedbackLayoutPath = require('path')
const feedbackLayoutVm = require('vm')
const { JSDOM: FeedbackLayoutDOM } = require('jsdom')
const feedbackLayoutEngine = require('../../jslib/dagitty-node.js')

function feedbackLayoutSource(file) {
    return feedbackLayoutFs.readFileSync(feedbackLayoutPath.join(__dirname, '../../', file), 'utf8').replace(/\r\n/g, '\n')
}

function feedbackLayouter(g) {
    const context = feedbackLayoutVm.createContext({ _: require('underscore'), Math })
    feedbackLayoutVm.runInContext(feedbackLayoutSource('jslib/graph/GraphLayouter.js'), context)
    return new context.GraphLayouter.Spring(g)
}

QUnit.module('feedback: compact layout and readable roles')

QUnit.test('component packing keeps disconnected diagrams nearby and preserves each component geometry', assert => {
    const g = feedbackLayoutEngine.GraphParser.parseGuess('dag { A [pos="0,0"] B [pos="3,2"] C [pos="100,100"] D [pos="104,100"] E [pos="-100,-100"] A -> B C -> D }')
    const delta = (a, b) => [g.getVertex(b).layout_pos_x-g.getVertex(a).layout_pos_x, g.getVertex(b).layout_pos_y-g.getVertex(a).layout_pos_y]
    const ab = delta('A', 'B'), cd = delta('C', 'D')
    const layouter = feedbackLayouter(g)
    layouter.layoutPackComponents()
    layouter.layoutCalcBounds()
    assert.deepEqual(delta('A', 'B'), ab, 'first component is translated without changing its shape')
    assert.deepEqual(delta('C', 'D'), cd, 'second component is translated without changing its shape')
    const bb = g.getBoundingBox()
    assert.ok(bb.every(Number.isFinite))
    assert.ok(bb[2]-bb[0] < 20 && bb[3]-bb[1] < 20, 'the isolated variable no longer leaves a huge empty region')
    const groups = [['A', 'B'], ['C', 'D'], ['E']].map(ids => {
        const vs = ids.map(id => g.getVertex(id))
        return [Math.min(...vs.map(v => v.layout_pos_x)), Math.min(...vs.map(v => v.layout_pos_y)),
            Math.max(...vs.map(v => v.layout_pos_x)), Math.max(...vs.map(v => v.layout_pos_y))]
    })
    for (let i = 0; i < groups.length; i++) for (let j = i+1; j < groups.length; j++) {
        const a = groups[i], b = groups[j]
        assert.ok(b[0]-a[2] >= 2 || a[0]-b[2] >= 2 || b[1]-a[3] >= 2 || a[1]-b[3] >= 2,
            'component frames remain separated')
    }
    assert.equal(g.getEdges().length, 2, 'packing does not invent connecting arrows')
})

QUnit.test('spring layout handles all-isolated and empty models with finite bounds', assert => {
    const g = feedbackLayoutEngine.GraphParser.parseGuess('dag { A B C D E F G H I }')
    feedbackLayouter(g).layout()
    const positions = g.getVertices().map(v => [v.layout_pos_x, v.layout_pos_y])
    assert.equal(new Set(positions.map(p => p.join(','))).size, 9, 'isolated nodes have distinct positions')
    positions.forEach((p, i) => positions.slice(i+1).forEach(q => {
        assert.ok(Math.hypot(p[0]-q[0], p[1]-q[1]) >= 2, 'isolated variables do not overlap')
    }))
    assert.ok(g.getBoundingBox().every(Number.isFinite))
    const empty = feedbackLayoutEngine.GraphParser.parseGuess('dag {}')
    feedbackLayouter(empty).layout()
    assert.deepEqual(Array.from(empty.getBoundingBox()), [-.5, -.5, .5, .5], 'an empty model receives usable bounds')
})

QUnit.test('packing a connected diagram preserves its existing spring layout exactly', assert => {
    const g = feedbackLayoutEngine.GraphParser.parseGuess('dag { A [pos="-1,2"] B [pos="3,4"] A -> B }')
    const before = g.toString()
    feedbackLayouter(g).layoutPackComponents()
    assert.equal(g.toString(), before)
})

QUnit.test('classic and SEM canvas styles render readable E, O and A role text without replacing the variable name', assert => {
    const dom = new FeedbackLayoutDOM('<!doctype html>')
    const context = feedbackLayoutVm.createContext({ document: dom.window.document,
        Class: { extend: definition => definition }, DAGitty: { stylesheets: {} } })
    feedbackLayoutVm.runInContext(feedbackLayoutSource('jslib/gui/GraphGUI_SVG.js'), context)
    for (const style of ['semlike', 'original']) {
        feedbackLayoutVm.runInContext(feedbackLayoutSource('gui/js/styles/' + style + '.js'), context)
        const impl = Object.create(context.GraphGUI_SVG)
        impl.style = context.DAGitty.stylesheets.default
        impl.interactive = false
        for (const [role, letter, label] of [['exposure', 'E', 'Exposure'], ['outcome', 'O', 'Outcome'], ['adjusted', 'A', 'Adjusted']]) {
            const shape = { id: 'A < B', x: 0, y: 0 }
            impl.createVertexShape(role, shape)
            const marker = shape.dom.querySelector('.node-role')
            assert.equal(marker.localName, 'text', style + ' uses actual readable role text')
            assert.equal(marker.textContent, letter)
            assert.equal(marker.getAttribute('aria-label'), label)
            assert.equal(shape.dom.querySelector('.nodelabel').textContent, 'A < B', 'the variable name remains literal text')
        }
    }
    dom.window.close()
})

QUnit.test('deployed GUI includes the same packing and role renderer as source', assert => {
    const bundle = feedbackLayoutSource('gui/js/dagitty.js')
    assert.ok(bundle.includes(feedbackLayoutSource('jslib/graph/GraphLayouter.js')), 'the browser includes compact component layout')
    assert.ok(bundle.includes(feedbackLayoutSource('jslib/gui/GraphGUI_SVG.js')), 'the browser includes text role decorations')
})

QUnit.test('marking and unmarking a variable expose a clear selection state for styling', assert => {
    const dom = new FeedbackLayoutDOM('<!doctype html>')
    const context = feedbackLayoutVm.createContext({ document: dom.window.document,
        Class: { extend: definition => definition }, DAGitty: { stylesheets: {} } })
    feedbackLayoutVm.runInContext(feedbackLayoutSource('jslib/gui/GraphGUI_SVG.js'), context)
    feedbackLayoutVm.runInContext(feedbackLayoutSource('gui/js/styles/original.js'), context)
    const impl = Object.create(context.GraphGUI_SVG)
    impl.style = context.DAGitty.stylesheets.default
    impl.interactive = false
    const calls = []
    impl.callEventListener = (event, value) => calls.push([event, value])
    const shape = { id: 'A', x: 0, y: 0, v: { id: 'A' } }
    impl.createVertexShape('exposure', shape)
    const stroke = shape.dom.firstChild.getAttribute('stroke')
    impl.markVertexShape(shape)
    assert.true(shape.dom.classList.contains('vertex-selected'))
    assert.strictEqual(impl.getMarkedVertex(), shape.v, 'existing selection API remains intact')
    impl.unmarkVertexShape()
    assert.false(shape.dom.classList.contains('vertex-selected'))
    assert.equal(shape.dom.firstChild.getAttribute('stroke'), stroke, 'original stroke is restored')
    assert.notOk(impl.getMarkedVertex())
    assert.equal(calls.length, 2, 'both selection events are still emitted')
    dom.window.close()
})
