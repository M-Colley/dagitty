/* Publication exports must preserve the model's edge marks and keep long
 * variable labels and long arrows clear of each other in tidy mode. */
const publicationFs = require('fs')
const publicationPath = require('path')
const publicationVm = require('vm')
const { JSDOM: PublicationDOM } = require('jsdom')
const publicationDagitty = require('../../jslib/dagitty-node.js')

function publicationRuntime(code, measureText) {
    const dom = new PublicationDOM('<!doctype html><body><div id="pub-preview"></div><div id="pub-status"></div></body>')
    if (measureText) dom.window.SVGElement.prototype.getBBox = function () {
        if (this.tagName !== 'text') throw new Error('No aggregate SVG bounds in jsdom')
        return { x: 0, y: 0, width: measureText(this.textContent), height: 19.75 }
    }
    const model = { dag: typeof code === 'string' ? publicationDagitty.GraphParser.parseGuess(code) : code }
    const context = publicationVm.createContext({
        window: dom.window, document: dom.window.document,
        Model: model, Graph: publicationDagitty.Graph,
        XMLSerializer: dom.window.XMLSerializer
    })
    dom.window.Model = model
    publicationVm.runInContext(publicationFs.readFileSync(publicationPath.join(__dirname,
        '../../gui/js/publication-export.js'), 'utf8'), context)
    return { window: dom.window, context }
}

function publicationFigure(code, options, measureText) {
    const runtime = publicationRuntime(code, measureText)
    const markup = runtime.window.PubExport.svgMarkup(Object.assign({ layout: 'tidy', legend: false }, options))
    return new PublicationDOM(markup, { contentType: 'image/svg+xml' }).window.document
}

function publicationNodes(doc) {
    return Array.from(doc.querySelectorAll('.pub-nodes ellipse')).map(e => ({
        x: +e.getAttribute('cx'), y: +e.getAttribute('cy'),
        rx: +e.getAttribute('rx'), ry: +e.getAttribute('ry')
    }))
}

QUnit.module('publication export')

QUnit.test('tidy sizes rows around descriptive labels without changing the graph', assert => {
    const doc = publicationFigure('dag { "Prior experience of the technology" "Previous access to technical support" Y ' +
        '"Prior experience of the technology" -> Y "Previous access to technical support" -> Y }')
    const nodes = publicationNodes(doc), a = nodes[0], b = nodes[1]
    assert.equal(a.y, b.y, 'the two causes share a row')
    assert.ok(Math.abs(a.x - b.x) > a.rx + b.rx + 40, 'labels and node outlines have a clear gap')
    assert.notOk(/NaN|Infinity/.test(doc.documentElement.outerHTML), 'missing canvas coordinates are safe')
    const canvas = publicationFigure('dag { A B A -> B }', { layout: 'canvas' })
    assert.notOk(/NaN|Infinity/.test(canvas.documentElement.outerHTML), 'canvas mode also falls back for missing coordinates')
})

QUnit.test('long label corners fit inside the node ellipse', assert => {
    const doc = publicationFigure('dag { "A descriptive name for a study variable" }', {}, () => 400)
    const node = publicationNodes(doc)[0]
    const halfHeight = 19.75 / 2
    assert.ok(Math.pow(200 / node.rx, 2) + Math.pow(halfHeight / node.ry, 2) < 1,
        'the measured label bounding box is enclosed by the ellipse')
})

QUnit.test('a long confounder arrow clears the intervening variable', assert => {
    const doc = publicationFigure('dag { C X Y C -> X X -> Y C -> Y }')
    const nodes = publicationNodes(doc).sort((a, b) => a.y - b.y)
    const path = Array.from(doc.querySelectorAll('.pub-edges path')).find(e => / Q/.test(e.getAttribute('d')))
    assert.ok(path, 'the edge that skips X bends')
    const p = path.getAttribute('d').match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi).map(Number)
    const midpointX = .25 * p[0] + .5 * p[2] + .25 * p[4]
    assert.ok(Math.abs(midpointX - nodes[1].x) > nodes[1].rx + 12,
        'the curve itself, not only its control point, clears the intermediate node')
})

QUnit.test('fractional label measurements do not put both long arrows on one side', assert => {
    const doc = publicationFigure('dag { "Baseline wellbeing" "Screen time" "Sleep quality" "Mental wellbeing" ' +
        '"Baseline wellbeing" -> "Screen time" "Screen time" -> "Sleep quality" ' +
        '"Sleep quality" -> "Mental wellbeing" "Baseline wellbeing" -> "Mental wellbeing" ' +
        '"Screen time" -> "Mental wellbeing" }', {}, text => text.length * 8.317 + .137)
    const bends = Array.from(doc.querySelectorAll('.pub-edges path')).filter(p => / Q/.test(p.getAttribute('d')))
        .map(p => p.getAttribute('d').match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi).map(Number))
    const centre = publicationNodes(doc)[0].x
    assert.equal(bends.length, 2, 'both arrows skipping mediators curve')
    assert.ok((bends[0][2] - centre) * (bends[1][2] - centre) < 0,
        'nominally symmetric routes alternate sides despite floating-point measurement differences')
})

QUnit.test('same-row edges clear intervening nodes', assert => {
    const doc = publicationFigure('dag { A B C A <-> C }')
    const path = doc.querySelector('.pub-edges path')
    assert.ok(/ Q/.test(path.getAttribute('d')), 'the bidirected edge bends around B')
    assert.equal(path.getAttribute('marker-start'), 'url(#pub-arrow)')
    assert.equal(path.getAttribute('marker-end'), 'url(#pub-arrow)')
})

QUnit.test('PAG exports preserve uncertain endpoints', assert => {
    const doc = publicationFigure('pag { A B C D A @-> B B @-@ C C @-- D }')
    const paths = Array.from(doc.querySelectorAll('.pub-edges path'))
    assert.deepEqual(paths.map(p => [p.getAttribute('marker-start'), p.getAttribute('marker-end')]), [
        ['url(#pub-circle)', 'url(#pub-arrow)'],
        ['url(#pub-circle)', 'url(#pub-circle)'],
        ['url(#pub-circle)', null]
    ], 'partial orientation is not replaced by an undirected edge')
    const nodes = publicationNodes(doc), circlePath = paths[0].getAttribute('d').match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi).map(Number)
    assert.ok(Math.abs(circlePath[0] - nodes[0].x) > nodes[0].rx + 5,
        'the whole circle endpoint clears the node fill')
})

QUnit.test('PDAG exports retain unresolved connections without arrowheads', assert => {
    const doc = publicationFigure('pdag { A B C A -- B B -> C }')
    const paths = Array.from(doc.querySelectorAll('.pub-edges path'))
    assert.deepEqual(paths.map(p => [p.getAttribute('marker-start'), p.getAttribute('marker-end')]), [
        [null, null], [null, 'url(#pub-arrow)']
    ], 'undirected PC connections stay undirected in the publication figure')
})

QUnit.test('downward bends fit the fallback frame and stay above the legend', assert => {
    // A second symmetric long edge chooses the downward side of the row.
    const doc = publicationFigure('dag { A [exposure] B C D E F G H I J [outcome] A <-> I B <-> J }', { legend: true })
    const paths = Array.from(doc.querySelectorAll('.pub-edges path'))
    const controls = paths.map(p => p.getAttribute('d').match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi).map(Number))
    const below = Math.max(...controls.map(p => p[3]))
    const frame = doc.documentElement.getAttribute('viewBox').split(' ').map(Number)
    assert.ok(frame[1] + frame[3] > below, 'the lower bend is inside the exported frame when getBBox is unavailable')
    const legendY = +doc.querySelector('.pub-legend text').getAttribute('y')
    assert.ok(legendY > below + 20, 'legend text does not sit on a long downward curve')
})

QUnit.test('legends match the rendered role styles', assert => {
    const code = 'dag { X [exposure] Y [outcome] X -> Y }'
    const uniform = publicationFigure(code, { uniform: true, legend: true })
    assert.notOk(uniform.querySelector('.pub-legend'), 'uniform shapes do not claim different role encodings')
    const bw = publicationFigure(code, { style: { palette: 'bw', mode: 'fill' }, legend: true })
    assert.equal(bw.querySelectorAll('.pub-legend ellipse').length, 3, 'outcome legend uses the same double ring as the node')
    assert.equal(bw.querySelector('.pub-legend ellipse').getAttribute('stroke-width'), '2.8', 'exposure legend uses the same heavy stroke')
})

QUnit.test('black-and-white outcomes keep their role when conditioned', assert => {
    const doc = publicationFigure('dag { X [exposure] Y [outcome,adjusted] X -> Y }', { style: { palette: 'bw', mode: 'fill' } })
    assert.equal(doc.querySelectorAll('.pub-nodes rect').length, 2,
        'a double rectangle encodes both outcome and conditioning')
})

QUnit.test('minimal and outlined labels retain legible text colors', assert => {
    ;['minimal', 'outline'].forEach(mode => {
        const doc = publicationFigure('dag { X [exposure] U [latent] S [selected] Y [outcome] U -> X X -> Y X -> S }',
            { style: { palette: 'color', mode }, legend: true })
        const colors = Object.fromEntries(Array.from(doc.querySelectorAll('.pub-nodes text'))
            .map(t => [t.textContent, t.getAttribute('fill')]))
        assert.equal(colors.U, '#495057', mode + ' unobserved label is dark enough to read')
        assert.equal(colors.X, '#14532d', mode + ' exposure label uses the darker role text color')
        assert.equal(colors.S, '#7f2d05', mode + ' selection label uses the darker role text color')
    })
})

QUnit.test('PNG allocation and encoding failures show a recoverable error', assert => {
    ;['context', 'encoding'].forEach(failure => {
        const runtime = publicationRuntime('dag { A B A -> B }'), document = runtime.window.document
        let revoked = 0
        runtime.context.Blob = runtime.window.Blob
        runtime.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => revoked++ }
        runtime.context.Image = class { set src(value) { this.onload() } }
        const create = document.createElement.bind(document)
        document.createElement = function (tag) {
            if (tag === 'canvas') return {
                getContext: () => failure === 'context' ? null : { fillRect() {}, drawImage() {} },
                toBlob: callback => callback(null)
            }
            return create(tag)
        }
        runtime.window.PubExport.downloadPNG()
        const status = document.getElementById('pub-status')
        assert.ok(status.classList.contains('status-error'), failure + ' failure is shown in the dialog')
        assert.ok(/lower resolution|SVG/.test(status.textContent), 'a useful next action is given')
        assert.equal(revoked, 1, 'the temporary image URL is released')
    })
})

QUnit.test('variable names that match object properties remain ordinary nodes', assert => {
    // Isolate the renderer: upstream GraphParser itself uses plain dictionaries
    // for some of these names, so it cannot construct this fixture from text.
    const empty = () => []
    const doc = publicationFigure({
        getVertices: () => [{ id: 'constructor' }, { id: 'toString' }],
        getEdges: empty, getSources: empty, getTargets: empty,
        getAdjustedNodes: empty, getLatentNodes: empty, getSelectedNodes: empty
    })
    const shapes = Array.from(doc.querySelectorAll('.pub-nodes ellipse'))
    assert.equal(shapes.length, 2)
    assert.ok(shapes.every(e => e.getAttribute('stroke') === '#495057'), 'ordinary variables do not acquire exposure styling')
})
