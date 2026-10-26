/* DAGitty — Publication-quality figure export
 *
 * Stock DAGitty graphics are hard to drop into a manuscript. This module
 * re-renders the current model as a clean, self-contained vector figure that
 * follows the usual DAG drawing conventions (conditioned variables in boxes,
 * unobserved variables dashed) and exports it as SVG, high-resolution PNG, or
 * PDF (via the browser's print-to-PDF). Augments the GUI without touching
 * main.js.
 *
 * Geometry is read straight from the graph model: vertices carry
 * layout_pos_x / layout_pos_y, and bent edges carry their own control point —
 * the same fields the built-in TikZ exporter uses.
 */

(function () {
    'use strict';

    var SVGNS = 'http://www.w3.org/2000/svg';

    // ── Palettes ────────────────────────────────────────────────────────────────
    // Per role: { fill, stroke, text }. "bw" carries no colour so it survives mono
    // printing; roles are then told apart by shape + line weight (see drawNode).
    var PALETTES = {
        color: {
            exposure: { fill: '#d3f0d8', stroke: '#2f9e44', text: '#14532d' },
            outcome:  { fill: '#d4e4fb', stroke: '#1971c2', text: '#0b3d6b' },
            adjusted: { fill: '#ffffff', stroke: '#495057', text: '#212529' },
            latent:   { fill: '#f1f3f5', stroke: '#adb5bd', text: '#495057' },
            selected: { fill: '#ffe8cc', stroke: '#e8590c', text: '#7f2d05' },
            other:    { fill: '#ffffff', stroke: '#495057', text: '#212529' },
            edge: '#343a40'
        },
        gray: {
            exposure: { fill: '#d4d4d4', stroke: '#1a1a1a', text: '#000000' },
            outcome:  { fill: '#9e9e9e', stroke: '#1a1a1a', text: '#000000' },
            adjusted: { fill: '#ffffff', stroke: '#1a1a1a', text: '#000000' },
            latent:   { fill: '#efefef', stroke: '#666666', text: '#333333' },
            selected: { fill: '#c4c4c4', stroke: '#1a1a1a', text: '#000000' },
            other:    { fill: '#ffffff', stroke: '#1a1a1a', text: '#000000' },
            edge: '#1a1a1a'
        },
        bw: {
            exposure: { fill: '#ffffff', stroke: '#000000', text: '#000000' },
            outcome:  { fill: '#ffffff', stroke: '#000000', text: '#000000' },
            adjusted: { fill: '#ffffff', stroke: '#000000', text: '#000000' },
            latent:   { fill: '#ffffff', stroke: '#000000', text: '#000000' },
            selected: { fill: '#ffffff', stroke: '#000000', text: '#000000' },
            other:    { fill: '#ffffff', stroke: '#000000', text: '#000000' },
            edge: '#000000'
        }
    };

    // A style = a palette + a drawing mode.
    //   fill    – role colour fills the node
    //   outline – white node, role colour on the border + label
    //   minimal – no node outline (except conditioned/latent, for meaning);
    //             role colour on the label, with a halo so edges read cleanly
    var STYLES = {
        soft:    { palette: 'color', mode: 'fill' },
        outline: { palette: 'color', mode: 'outline' },
        minimal: { palette: 'color', mode: 'minimal' },
        gray:    { palette: 'gray',  mode: 'fill' },
        bw:      { palette: 'bw',    mode: 'fill' }
    };

    var FONTS = {
        sans:  'Helvetica, Arial, sans-serif',
        serif: 'Georgia, "Times New Roman", Times, serif',
        inter: '"Inter", system-ui, sans-serif'
    };

    // ── Helpers ─────────────────────────────────────────────────────────────────

    function el(name, attrs) {
        var e = document.createElementNS(SVGNS, name);
        if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
        return e;
    }

    function roleSets(g) {
        var by = function (arr) { var s = Object.create(null); (arr || []).forEach(function (v) { s[v.id] = 1; }); return s; };
        return {
            exposure: by(g.getSources()),
            outcome:  by(g.getTargets()),
            adjusted: by(g.getAdjustedNodes()),
            latent:   by(g.getLatentNodes()),
            selected: by(g.getSelectedNodes ? g.getSelectedNodes() : [])
        };
    }

    function roleOf(id, roles) {
        if (roles.exposure[id]) return 'exposure';
        if (roles.outcome[id])  return 'outcome';
        if (roles.selected[id]) return 'selected';
        if (roles.latent[id])   return 'latent';
        if (roles.adjusted[id]) return 'adjusted';
        return 'other';
    }
    function isBoxed(id, roles) { return !!(roles.adjusted[id] || roles.selected[id]); }
    function isDashed(id, roles) { return !!roles.latent[id]; }

    function opts() {
        var v = function (id, dflt) { var e = document.getElementById(id); return e ? e.value : dflt; };
        var c = function (id) { var e = document.getElementById(id); return e ? e.checked : false; };
        var styleKey = v('pub-style', 'soft');
        return {
            style:      STYLES[styleKey] || STYLES.soft,
            styleKey:   styleKey,
            layout:     v('pub-layout', 'canvas'),
            font:       FONTS[v('pub-font', 'sans')] || FONTS.sans,
            fontSize:   parseFloat(v('pub-fontsize', '17')) || 17,
            uniform:    v('pub-shape', 'role') === 'uniform',
            curved:     c('pub-curved'),
            legend:     c('pub-legend'),
            transparent: v('pub-bg', 'white') === 'transparent'
        };
    }

    // ── Layered (Sugiyama-style) auto-tidy layout ───────────────────────────────
    // Ranks nodes by longest directed path so arrows flow top→bottom, then orders
    // each layer by neighbour barycentre to cut crossings. Returns id -> {x,y} in
    // graph units (the renderer normalises + scales to fit). Cycle-safe; ignores
    // bidirected/undirected edges for ranking. Does NOT touch the canvas model.
    function layeredLayout(g) {
        var ids = g.getVertices().map(function (v) { return v.id; });
        var parents = Object.create(null), children = Object.create(null);
        ids.forEach(function (id) { parents[id] = []; children[id] = []; });
        g.getEdges().forEach(function (e) {
            if (e.directed === Graph.Edgetype.Directed && parents[e.v2.id] && children[e.v1.id]) {
                parents[e.v2.id].push(e.v1.id);
                children[e.v1.id].push(e.v2.id);
            }
        });

        // Longest-path layering via bounded relaxation (safe even if a cycle exists).
        var layer = Object.create(null);
        ids.forEach(function (id) { layer[id] = 0; });
        for (var it = 0; it < ids.length; it++) {
            var changed = false;
            ids.forEach(function (id) {
                parents[id].forEach(function (p) {
                    if (layer[p] + 1 > layer[id]) { layer[id] = layer[p] + 1; changed = true; }
                });
            });
            if (!changed) break;
        }

        var layers = [];
        ids.forEach(function (id) { (layers[layer[id]] = layers[layer[id]] || []).push(id); });
        layers = layers.filter(function (l) { return l && l.length; });

        var pos = Object.create(null);
        layers.forEach(function (L) { L.forEach(function (id, i) { pos[id] = i; }); });
        var sweep = function (useParents) {
            layers.forEach(function (L) {
                var bary = Object.create(null);
                L.forEach(function (id) {
                    var nb = useParents ? parents[id] : children[id], sum = 0, c = 0;
                    nb.forEach(function (x) { if (pos[x] != null) { sum += pos[x]; c++; } });
                    bary[id] = c ? sum / c : pos[id];
                });
                L.sort(function (a, b) { return bary[a] - bary[b]; });
                L.forEach(function (id, i) { pos[id] = i; });
            });
        };
        for (var s = 0; s < 4; s++) { sweep(true); sweep(false); }

        var coords = Object.create(null), hgap = 1.5, vgap = 1.0;
        layers.forEach(function (L, li) {
            var n = L.length;
            L.forEach(function (id, i) { coords[id] = { x: (i - (n - 1) / 2) * hgap, y: li * vgap }; });
        });
        return { coords: coords, layer: layer };
    }

    // Lay out measured node boxes, not just their centres. Fixed graph-unit
    // spacing made descriptive variable names overlap in otherwise tidy DAGs.
    function spaceTidyNodes(verts, node, layout, pad) {
        var rows = Object.create(null), rowKeys;
        verts.forEach(function (v) {
            var key = layout.layer[v.id];
            (rows[key] = rows[key] || []).push(v.id);
        });
        rowKeys = Object.keys(rows).sort(function (a, b) { return +a - +b; });
        var widest = 0, gap = 54;
        rowKeys.forEach(function (key) {
            rows[key].sort(function (a, b) { return layout.coords[a].x - layout.coords[b].x; });
            var width = -gap;
            rows[key].forEach(function (id) { width += node[id].rx * 2 + gap; });
            rows[key].width = width;
            widest = Math.max(widest, width);
        });
        var rowY = pad;
        rowKeys.forEach(function (key) {
            var row = rows[key], x = pad + (widest - row.width) / 2, height = 0;
            row.forEach(function (id) { height = Math.max(height, node[id].ry); });
            row.forEach(function (id) {
                var n = node[id];
                n.cx = x + n.rx; n.cy = rowY + height;
                n._t.setAttribute('x', n.cx); n._t.setAttribute('y', n.cy);
                x += n.rx * 2 + gap;
            });
            rowY += height * 2 + 72;
        });
    }

    // Route a long arrow around the full width of intervening nodes. A fixed
    // 45px control-point offset only moves a quadratic curve 22.5px at its
    // midpoint, so the old curve still ran through confounder/mediator labels.
    function tidyControl(n1, n2, node, verts, preferLeft) {
        var dy = n2.cy - n1.cy;
        if (Math.abs(dy) < 1) {
            if (Math.abs(n2.cx - n1.cx) < 1) return null;
            // Undirected and bidirected edges can join nodes in the same row.
            // Rotate the problem so these also clear intervening variables.
            var rotated = Object.create(null);
            verts.forEach(function (v) {
                var n = node[v.id];
                rotated[v.id] = { cx: n.cy, cy: n.cx, rx: n.ry, ry: n.rx };
            });
            var ids = verts.map(function (v) { return v.id; });
            var a = ids.filter(function (id) { return node[id] === n1; })[0];
            var b = ids.filter(function (id) { return node[id] === n2; })[0];
            var c = tidyControl(rotated[a], rotated[b], rotated, verts, preferLeft);
            return c ? { x: c.y, y: c.x } : null;
        }
        var left = (n1.cx + n2.cx) / 2, right = left, blocked = false;
        verts.forEach(function (v) {
            var n = node[v.id];
            if (n === n1 || n === n2) return;
            var lo = Math.min((n.cy - n.ry - 14 - n1.cy) / dy, (n.cy + n.ry + 14 - n1.cy) / dy);
            var hi = Math.max((n.cy - n.ry - 14 - n1.cy) / dy, (n.cy + n.ry + 14 - n1.cy) / dy);
            if (lo <= 0 || hi >= 1) return;
            var lineLo = n1.cx + lo * (n2.cx - n1.cx);
            var lineHi = n1.cx + hi * (n2.cx - n1.cx);
            if (Math.max(lineLo, lineHi) >= n.cx - n.rx - 14 &&
                Math.min(lineLo, lineHi) <= n.cx + n.rx + 14) blocked = true;
            // In this parameterisation y(t) is linear. Requiring the curve to
            // stay outside the box at both ends and its centre clears the row.
            [lo, (lo + hi) / 2, hi].forEach(function (t) {
                var base = (1 - t) * (1 - t) * n1.cx + t * t * n2.cx;
                var weight = 2 * t * (1 - t);
                left = Math.min(left, (n.cx - n.rx - 22 - base) / weight);
                right = Math.max(right, (n.cx + n.rx + 22 - base) / weight);
            });
        });
        if (!blocked) return null;
        var mid = (n1.cx + n2.cx) / 2;
        var leftCost = Math.abs(mid - left), rightCost = Math.abs(right - mid);
        // Label measurements contain fractional pixels. Symmetric routes can
        // differ by machine precision, which previously defeated alternation
        // and put both long arrows on the same side of a mediator chain.
        var useLeft = Math.abs(leftCost - rightCost) <= 1 ? preferLeft : leftCost < rightCost;
        return { x: useLeft ? left : right, y: (n1.cy + n2.cy) / 2 };
    }

    // ── Core renderer ───────────────────────────────────────────────────────────

    function build(container, g, o) {
        container.innerHTML = '';
        var roles = roleSets(g);
        var verts = g.getVertices();
        var edges = g.getEdges();

        if (!verts.length) {
            container.innerHTML = '<p class="pub-empty">Add at least one variable to the diagram first.</p>';
            return null;
        }

        var palette = PALETTES[o.style.palette] || PALETTES.color;
        var mode = o.style.mode;
        var edgeColor = mode === 'minimal' ? '#868e96' : palette.edge;
        var edgeWidth = mode === 'minimal' ? 1.4 : 1.7;

        // 1. Map graph coordinates to a pixel canvas.
        var tidy = o.layout === 'tidy' || !verts.every(function (v) {
            return isFinite(v.layout_pos_x) && isFinite(v.layout_pos_y);
        });
        var tl = tidy ? layeredLayout(g) : null;
        var coords = tl ? tl.coords : null;
        var nodeLayer = tl ? tl.layer : null;
        var gx = function (v) { return tidy ? coords[v.id].x : v.layout_pos_x; };
        var gy = function (v) { return tidy ? coords[v.id].y : v.layout_pos_y; };
        var xs = verts.map(gx);
        var ys = verts.map(gy);
        var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        var spanX = Math.max(maxX - minX, 0.001), spanY = Math.max(maxY - minY, 0.001);
        var scale = Math.min(600 / spanX, 470 / spanY);
        if (!isFinite(scale) || scale <= 0) scale = 130;
        scale = Math.max(64, Math.min(scale, 210));
        var pad = 52;
        var px = function (x) { return pad + (x - minX) * scale; };
        var py = function (y) { return pad + (y - minY) * scale; };

        var svg = el('svg', { 'font-family': o.font });
        var defs = el('defs');
        defs.appendChild(arrowMarker('pub-arrow', edgeColor));
        var circle = el('marker', { id: 'pub-circle', viewBox: '0 0 10 10', refX: '5', refY: '5',
            markerWidth: '7', markerHeight: '7', orient: 'auto' });
        circle.appendChild(el('circle', { cx: '5', cy: '5', r: '3.1', fill: '#ffffff', stroke: edgeColor, 'stroke-width': '1' }));
        defs.appendChild(circle);
        svg.appendChild(defs);
        container.appendChild(svg);

        var gEdges = el('g', { 'class': 'pub-edges' });
        var gNodes = el('g', { 'class': 'pub-nodes' });
        svg.appendChild(gEdges);
        svg.appendChild(gNodes);

        // 2. Place + measure labels; size every node to a shared height for a
        //    consistent, tidy look.
        var node = Object.create(null);
        var maxRy = 17;
        verts.forEach(function (v) {
            var t = el('text', {
                x: px(gx(v)), y: py(gy(v)),
                'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': o.fontSize, 'font-weight': mode === 'minimal' ? '700' : '600'
            });
            t.textContent = v.id;
            gNodes.appendChild(t);
            var bb; try { bb = t.getBBox(); } catch (e) { bb = null; }
            var tw = (bb && bb.width)  ? bb.width  : v.id.length * o.fontSize * 0.58;
            var th = (bb && bb.height) ? bb.height : o.fontSize * 1.05;
            node[v.id] = { _t: t, _tw: tw, _th: th, cx: px(gx(v)), cy: py(gy(v)) };
            maxRy = Math.max(maxRy, th / 2 + 9);
        });
        verts.forEach(function (v) {
            var n = node[v.id], padX = 15;
            n.ry = maxRy;
            n.hh = maxRy;
            // The label's upper/lower corners must fit the ellipse, whose
            // usable width narrows away from its horizontal centre line.
            var labelHalfHeight = Math.min(n._th / 2, maxRy * 0.95);
            n.rx = Math.max((n._tw / 2 + padX) / Math.sqrt(1 - Math.pow(labelHalfHeight / maxRy, 2)), maxRy * 1.25);
            n.hw = Math.max(n._tw / 2 + padX, maxRy * 1.2);
            n.boxed = !o.uniform && isBoxed(v.id, roles);
            n.role = roleOf(v.id, roles);
        });
        if (tidy) spaceTidyNodes(verts, node, tl, pad);

        // 3. Edges (under the nodes).
        var longEdgeIdx = 0, bendMinX = Infinity, bendMaxX = -Infinity, bendMinY = Infinity, bendMaxY = -Infinity;
        edges.forEach(function (e) {
            var n1 = node[e.v1.id], n2 = node[e.v2.id];
            if (!n1 || !n2) return;

            // Gently tame any stored bend toward the straight midpoint so curves
            // stay subtle rather than ballooning the way the canvas drew them.
            var ctrl = null;
            if (o.curved && !tidy && e.layout_pos_x != null && e.layout_pos_y != null) {
                var bx = px(e.layout_pos_x), by = py(e.layout_pos_y);
                var mx = (n1.cx + n2.cx) / 2, my = (n1.cy + n2.cy) / 2;
                ctrl = { x: mx + 0.45 * (bx - mx), y: my + 0.45 * (by - my) };
            }

            // In tidy mode, edges that skip a layer (e.g. a confounder pointing
            // past the exposure to the outcome) would otherwise lie on top of the
            // nodes/edges between them. Bow them aside, alternating sides.
            if (tidy && nodeLayer) {
                var span = Math.abs((nodeLayer[e.v1.id] || 0) - (nodeLayer[e.v2.id] || 0));
                if (span >= 2 || span === 0) {
                    ctrl = tidyControl(n1, n2, node, verts, longEdgeIdx++ % 2 === 0);
                }
            }
            if (ctrl) {
                bendMinX = Math.min(bendMinX, ctrl.x); bendMaxX = Math.max(bendMaxX, ctrl.x);
                bendMinY = Math.min(bendMinY, ctrl.y); bendMaxY = Math.max(bendMaxY, ctrl.y);
            }
            var directed   = e.directed === Graph.Edgetype.Directed;
            var bidirected = e.directed === Graph.Edgetype.Bidirected;
            var partDirected = e.directed === Graph.Edgetype.PartDirected;
            var circleStart = partDirected || e.directed === Graph.Edgetype.PartUndirected || e.directed === Graph.Edgetype.Unspecified;
            var circleEnd = e.directed === Graph.Edgetype.Unspecified;
            var aim1 = ctrl || { x: n2.cx, y: n2.cy };
            var aim2 = ctrl || { x: n1.cx, y: n1.cy };
            // Circle markers are centred on the endpoint, unlike arrow tips.
            // Leave room for the whole circle so the later node fill does not
            // cover its inner half and change the endpoint's appearance.
            var s = boundaryPoint(n1, aim1.x, aim1.y, circleStart ? 6 : 1.5);
            var t = boundaryPoint(n2, aim2.x, aim2.y, circleEnd ? 6 : 2.5);
            var d = ctrl
                ? 'M' + s.x + ',' + s.y + ' Q' + ctrl.x + ',' + ctrl.y + ' ' + t.x + ',' + t.y
                : 'M' + s.x + ',' + s.y + ' L' + t.x + ',' + t.y;

            var path = el('path', {
                d: d, fill: 'none', stroke: edgeColor, 'stroke-width': edgeWidth, 'stroke-linecap': 'round'
            });
            if (bidirected) { path.setAttribute('stroke-dasharray', ''); }
            if (directed || bidirected || partDirected) path.setAttribute('marker-end', 'url(#pub-arrow)');
            if (bidirected) path.setAttribute('marker-start', 'url(#pub-arrow)');
            if (circleStart) path.setAttribute('marker-start', 'url(#pub-circle)');
            if (circleEnd) path.setAttribute('marker-end', 'url(#pub-circle)');
            gEdges.appendChild(path);
        });

        // 4. Nodes (shape behind label).
        verts.forEach(function (v) { drawNode(gNodes, node[v.id], v, roles, palette, o, mode); });

        // 5. Optional legend.
        if (o.legend && !o.uniform) {
            var legendTop = Math.max(bendMaxY, Math.max.apply(null, verts.map(function (v) { return node[v.id].cy + node[v.id].ry; }))) + 36;
            buildLegend(svg, roles, palette, o, mode, pad, legendTop);
        }

        // 6. Frame everything.
        var bb; try { bb = svg.getBBox(); } catch (e) { bb = null; }
        var margin = 18, x0, y0, w, h;
        if (bb && bb.width) {
            x0 = bb.x - margin; y0 = bb.y - margin; w = bb.width + margin * 2; h = bb.height + margin * 2;
        } else {
            x0 = Math.min(bendMinX, Math.min.apply(null, verts.map(function (v) { return node[v.id].cx - node[v.id].rx; }))) - margin;
            y0 = Math.min(bendMinY, Math.min.apply(null, verts.map(function (v) { return node[v.id].cy - node[v.id].ry; }))) - margin;
            w = Math.max(bendMaxX, Math.max.apply(null, verts.map(function (v) { return node[v.id].cx + node[v.id].rx; }))) - x0 + margin;
            h = Math.max(bendMaxY, Math.max.apply(null, verts.map(function (v) { return node[v.id].cy + node[v.id].ry; }))) - y0 + margin;
            if (o.legend && !o.uniform) {
                w = Math.max(w, pad + 250 - x0);
                h += 36 + Object.keys(roles).filter(function (role) { return Object.keys(roles[role]).length; }).length * 19;
            }
        }
        svg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + w + ' ' + h);
        svg.setAttribute('width', Math.round(w));
        svg.setAttribute('height', Math.round(h));
        if (!o.transparent) {
            svg.insertBefore(el('rect', { x: x0, y: y0, width: w, height: h, fill: '#ffffff' }),
                svg.firstChild.nextSibling);
        }
        return svg;
    }

    function drawNode(gNodes, n, v, roles, palette, o, mode) {
        var role = o.uniform ? 'other' : n.role;
        var col = palette[role] || palette.other;
        var dashed = !o.uniform && isDashed(v.id, roles);
        var t = n._t;

        var drawShape = true, shapeFill = col.fill, shapeStroke = col.stroke, shapeSW = 1.6, textFill = col.text;
        var ringForOutcome = false, halo = false;

        if (mode === 'minimal') {
            textFill = col.text;
            halo = true;
            drawShape = n.boxed || dashed; // keep meaning for conditioned / latent only
            shapeFill = 'none';
            shapeStroke = col.stroke;
            shapeSW = 1.4;
        } else if (mode === 'outline') {
            shapeFill = o.transparent ? 'none' : '#ffffff';
            shapeStroke = col.stroke;
            shapeSW = 1.9;
            textFill = col.text;
        } else if (palette === PALETTES.bw && !o.uniform) {
            if (role === 'exposure') shapeSW = 2.8;
            if (role === 'outcome')  ringForOutcome = true;
        }

        if (drawShape) {
            var shape;
            if (n.boxed) {
                shape = el('rect', { x: n.cx - n.hw, y: n.cy - n.hh, width: n.hw * 2, height: n.hh * 2,
                    rx: 4, fill: shapeFill, stroke: shapeStroke, 'stroke-width': shapeSW });
            } else {
                shape = el('ellipse', { cx: n.cx, cy: n.cy, rx: n.rx, ry: n.ry,
                    fill: shapeFill, stroke: shapeStroke, 'stroke-width': shapeSW });
            }
            if (dashed) shape.setAttribute('stroke-dasharray', '5,3');
            gNodes.insertBefore(shape, t);
            if (ringForOutcome) {
                var ring = n.boxed
                    ? el('rect', { x: n.cx - n.hw + 3.4, y: n.cy - n.hh + 3.4, width: n.hw * 2 - 6.8, height: n.hh * 2 - 6.8,
                        rx: 2, fill: 'none', stroke: shapeStroke, 'stroke-width': 1.2 })
                    : el('ellipse', { cx: n.cx, cy: n.cy, rx: n.rx - 3.4, ry: n.ry - 3.4,
                        fill: 'none', stroke: shapeStroke, 'stroke-width': 1.2 });
                gNodes.insertBefore(ring, t);
            }
        }
        t.setAttribute('fill', textFill);
        if (halo) {
            t.setAttribute('paint-order', 'stroke');
            t.setAttribute('stroke', '#ffffff');
            t.setAttribute('stroke-width', '3.4');
            t.setAttribute('stroke-linejoin', 'round');
        }
    }

    function arrowMarker(id, color) {
        var m = el('marker', { id: id, viewBox: '0 0 8 8', refX: '7', refY: '4',
            markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
        m.appendChild(el('path', { d: 'M0.5,0.6 L7.2,4 L0.5,7.4 L2.4,4 Z', fill: color }));
        return m;
    }

    // Point where the segment from node centre toward (tx,ty) meets the boundary,
    // pulled in by `gap` px.
    function boundaryPoint(n, tx, ty, gap) {
        var dx = tx - n.cx, dy = ty - n.cy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / len, uy = dy / len, s;
        if (n.boxed) {
            var sx = Math.abs(ux) < 1e-6 ? Infinity : n.hw / Math.abs(ux);
            var sy = Math.abs(uy) < 1e-6 ? Infinity : n.hh / Math.abs(uy);
            s = Math.min(sx, sy);
        } else {
            s = 1 / Math.sqrt((ux / n.rx) * (ux / n.rx) + (uy / n.ry) * (uy / n.ry));
        }
        return { x: n.cx + ux * (s + gap), y: n.cy + uy * (s + gap) };
    }

    function buildLegend(svg, roles, palette, o, mode, x, y) {
        var present = [];
        var has = function (set) { return Object.keys(set).length > 0; };
        if (has(roles.exposure)) present.push(['exposure', 'exposure (cause)']);
        if (has(roles.outcome))  present.push(['outcome',  'outcome (effect)']);
        if (has(roles.adjusted)) present.push(['adjusted', 'adjusted / conditioned']);
        if (has(roles.selected)) present.push(['selected', 'sample selection']);
        if (has(roles.latent))   present.push(['latent',   'unobserved (latent)']);
        if (!present.length) return;

        var gL = el('g', { 'class': 'pub-legend' });
        var sw = 24, gap = 19, fs = Math.max(11, o.fontSize - 5);
        present.forEach(function (item, i) {
            var role = item[0], label = item[1], col = palette[role] || palette.other;
            var cy = y + i * gap;
            var boxed = role === 'adjusted' || role === 'selected';
            var fill, stroke;
            if (mode === 'minimal') { fill = boxed || role === 'latent' ? 'none' : col.stroke; stroke = col.stroke; }
            else if (mode === 'outline') { fill = '#ffffff'; stroke = col.stroke; }
            else { fill = col.fill; stroke = col.stroke; }

            var swatch = mode === 'minimal' && !boxed && role !== 'latent'
                ? el('text', { x: x + sw / 2, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
                    'font-size': fs, 'font-weight': '700', fill: col.text })
                : boxed
                ? el('rect', { x: x, y: cy - 6.5, width: sw, height: 13, rx: 3, fill: fill, stroke: stroke, 'stroke-width': 1.4 })
                : el('ellipse', { cx: x + sw / 2, cy: cy, rx: sw / 2, ry: 7.5, fill: fill, stroke: stroke, 'stroke-width': 1.4 });
            if (swatch.tagName === 'text') swatch.textContent = 'X';
            if (palette === PALETTES.bw && role === 'exposure') swatch.setAttribute('stroke-width', '2.8');
            if (role === 'latent') swatch.setAttribute('stroke-dasharray', '4,2.5');
            gL.appendChild(swatch);
            if (palette === PALETTES.bw && role === 'outcome') {
                gL.appendChild(el('ellipse', { cx: x + sw / 2, cy: cy, rx: sw / 2 - 3.4, ry: 7.5 - 3.4,
                    fill: 'none', stroke: stroke, 'stroke-width': 1.2 }));
            }

            var txt = el('text', { x: x + sw + 9, y: cy, 'dominant-baseline': 'central',
                'font-size': fs, fill: palette.other.text });
            txt.textContent = label;
            gL.appendChild(txt);
        });
        svg.appendChild(gL);
    }

    // ── Export actions ──────────────────────────────────────────────────────────

    function currentSVG() {
        var container = document.getElementById('pub-preview');
        if (!container) return null;
        return build(container, Model.dag, opts());
    }

    function serialized(svg) {
        var clone = svg.cloneNode(true);
        clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns', SVGNS);
        return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
            new XMLSerializer().serializeToString(clone);
    }

    function triggerDownload(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    function downloadSVG() {
        var svg = currentSVG(); if (!svg) return;
        triggerDownload(new Blob([serialized(svg)], { type: 'image/svg+xml;charset=utf-8' }), 'dagitty-figure.svg');
    }

    function downloadPNG() {
        var svg = currentSVG(); if (!svg) return;
        var o = opts();
        var w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
        var scaleEl = document.getElementById('pub-png-scale');
        var scale = scaleEl ? (parseFloat(scaleEl.value) || 3) : 3;
        var img = new Image();
        var url = URL.createObjectURL(new Blob([serialized(svg)], { type: 'image/svg+xml;charset=utf-8' }));
        var fail = function () { setStatus('Could not create PNG at this size. Try a lower resolution or export SVG.', 'error'); };
        setStatus('Preparing PNG…');
        img.onload = function () {
            try {
                var canv = document.createElement('canvas');
                canv.width = Math.round(w * scale); canv.height = Math.round(h * scale);
                var ctx = canv.getContext('2d');
                if (!ctx) { fail(); return; }
                ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
                if (!o.transparent) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canv.width, canv.height); }
                ctx.drawImage(img, 0, 0, canv.width, canv.height);
                canv.toBlob(function (b) {
                    if (!b) { fail(); return; }
                    triggerDownload(b, 'dagitty-figure.png');
                    setStatus('PNG saved (' + canv.width + ' × ' + canv.height + ' pixels).');
                }, 'image/png');
            } catch (e) { fail(); }
            finally { URL.revokeObjectURL(url); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); setStatus('Could not render PNG in this browser — try SVG.', 'error'); };
        img.src = url;
    }

    function printPDF() {
        var svg = currentSVG(); if (!svg) return;
        var markup = serialized(svg);
        var win = window.open('', '_blank');
        if (!win) { setStatus('Pop-up blocked — allow pop-ups, then use Print to PDF.', 'error'); return; }
        win.document.write(
            '<!DOCTYPE html><html><head><title>DAGitty figure</title>' +
            '<style>@page{margin:12mm;}html,body{margin:0;height:100%;}' +
            'body{display:flex;align-items:center;justify-content:center;}' +
            'svg{display:block;max-width:100%;max-height:100%;width:auto;height:auto;}</style></head><body>' + markup + '</body></html>');
        win.document.close();
        win.focus();
        setTimeout(function () { try { win.print(); } catch (e) {} }, 350);
    }

    function setStatus(msg, type) {
        var e = document.getElementById('pub-status');
        if (!e) return;
        e.textContent = msg || '';
        e.className = 'pub-status' + (type ? ' status-' + type : '');
    }

    // ── Modal lifecycle ─────────────────────────────────────────────────────────

    function open() {
        if (!window.Model || !Model.dag) return;
        var modal = document.getElementById('pub-export-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        modal.onclick = function (e) { if (e.target === modal) close(); };
        setStatus('');
        refresh();
    }
    function close() {
        var modal = document.getElementById('pub-export-modal');
        if (modal) modal.style.display = 'none';
    }
    function refresh() {
        try { currentSVG(); setStatus(''); }
        catch (e) { setStatus('Could not render preview: ' + e.message, 'error'); }
    }

    /**
     * Serialised SVG of the current model using the dialog's current settings,
     * rendered off-screen (getBBox needs a live element). Used by the report
     * export; returns '' if there is nothing to draw.
     */
    function svgMarkup(overrides) {
        if (!window.Model || !Model.dag) return '';
        var host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-10000px;top:0;width:900px;height:700px;visibility:hidden';
        document.body.appendChild(host);
        try {
            var o = opts();
            if (overrides) for (var k in overrides) if (overrides.hasOwnProperty(k)) o[k] = overrides[k];
            var svg = build(host, Model.dag, o);
            return svg ? serialized(svg) : '';
        } finally {
            document.body.removeChild(host);
        }
    }

    window.PubExport = {
        open: open, close: close, refresh: refresh,
        downloadSVG: downloadSVG, downloadPNG: downloadPNG, printPDF: printPDF,
        svgMarkup: svgMarkup
    };

})();
