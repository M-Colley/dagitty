/*
 * 
 *  Some parts of the code in this file have been written by other authors,
 *  and were originally licensed under the MIT license. They originate from 
 *  the following projects: 
 * 
 *  - Dracula Graph Layout and Drawing Framework 0.0.3alpha
 *  (c) 2010 Philipp Strathausen <strathausen@gmail.com>,
 *      http://dracula.ameisenbar.de/index.html
 * 
 *  - which in turn are based on the Graph JavaScript framework, version 0.0.1
 *  (c) 2006 Aslak Hellesoy <aslak.hellesoy@gmail.com>
 *  (c) 2006 Dave Hoover <dave.hoover@gmail.com>
 *
 *  - Ported from Graph::Layouter::Spring in
 *    http://search.cpan.org/~pasky/Graph-Layderer-0.02/
 *  The algorithm is based on a spring-style layouter of a Java-based social
 *  network tracker PieSpy written by Paul Mutton E<lt>paul@jibble.orgE<gt>.
 *
/*--------------------------------------------------------------------------*/

/* globals _  */
/* exported GraphLayouter */

var GraphLayouter = {}
GraphLayouter.prototype = {
	layoutCalcBounds: function() {
		var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity
		if( this.graph.vertices.values().length === 0 ){
			this.graph.setBoundingBox([-.5,-.5,.5,.5])
			return
		}
		_.each(this.graph.vertices.values(), function( v ){
			var x = v.layout_pos_x
			var y = v.layout_pos_y

			if(x > maxx) maxx = x
			if(x < minx) minx = x
			if(y > maxy) maxy = y
			if(y < miny) miny = y            
		} )
		var xpad = Math.max( (maxx-minx)*.1, .5 )
		maxx += xpad
		minx -= xpad
		var ypad = Math.max( (maxy-miny)*.1, .5 )
		maxy += ypad
		miny -= ypad
		var trimn = function(n){ return Math.round(n*1e3)/1e3 }
		this.graph.setBoundingBox([minx,miny,maxx,maxy].map(trimn))
	}
}

GraphLayouter.Spring = function(graph) {
	this.graph = graph
	this.iterations = 500
	this.maxRepulsiveForceDistance = 6
	this.k = 2
	this.c = 0.01
	this.maxVertexMovement = 0.5
}

GraphLayouter.Spring.prototype = {
	layoutCalcBounds : GraphLayouter.prototype.layoutCalcBounds,

	layout: function() {
		this.layoutPrepare()
		for (var i = 0; i < this.iterations; i++) {
			this.layoutIteration()
		}
		this.layoutPackComponents()
		this.layoutCalcBounds()
	},

	// Separate components have no attractive springs between them. Pack their
	// finished layouts in nearby, non-overlapping frames so isolated variables
	// do not consume most of the canvas while the connected diagram shrinks.
	layoutPackComponents: function() {
		var vertices = this.graph.vertices.values(), adjacent = Object.create(null)
		var visited = Object.create(null), components = [], gap = this.k
		vertices.forEach(function(v){ adjacent[v.id] = [] })
		this.graph.edges.forEach(function(e){
			adjacent[e.v1.id].push(e.v2)
			adjacent[e.v2.id].push(e.v1)
		})
		vertices.forEach(function(v){
			if( visited[v.id] ) return
			var stack = [v], members = [], minx = Infinity, maxx = -Infinity
			var miny = Infinity, maxy = -Infinity
			visited[v.id] = true
			while( stack.length ){
				var next = stack.pop()
				members.push(next)
				minx = Math.min(minx, next.layout_pos_x); maxx = Math.max(maxx, next.layout_pos_x)
				miny = Math.min(miny, next.layout_pos_y); maxy = Math.max(maxy, next.layout_pos_y)
				adjacent[next.id].forEach(function(neighbor){
					if( !visited[neighbor.id] ){
						visited[neighbor.id] = true
						stack.push(neighbor)
					}
				})
			}
			components.push({ members: members, x: (minx+maxx)/2, y: (miny+maxy)/2,
				width: Math.max(gap, maxx-minx), height: Math.max(gap, maxy-miny) })
		})
		if( components.length < 2 ) return
		components.sort(function(a,b){ return b.members.length-a.members.length })
		var area = 0, maxWidth = 0
		components.forEach(function(c){
			area += (c.width+gap)*(c.height+gap)
			maxWidth = Math.max(maxWidth, c.width)
		})
		var rowWidth = Math.max(maxWidth, Math.sqrt(area)), x = 0, y = 0, rowHeight = 0
		components.forEach(function(c){
			if( x > 0 && x+c.width > rowWidth ){
				x = 0; y += rowHeight+gap; rowHeight = 0
			}
			var dx = x+c.width/2-c.x, dy = y+c.height/2-c.y
			c.members.forEach(function(v){ v.layout_pos_x += dx; v.layout_pos_y += dy })
			x += c.width+gap
			rowHeight = Math.max(rowHeight, c.height)
		})
	},

	layoutPrepare: function() {
		_.each(this.graph.vertices.values(), function( v ){
			v.layout_pos_x = 0
			v.layout_pos_y = 0
			v.layoutForceX = 0
			v.layoutForceY = 0            
		} )
		_.each(this.graph.edges, function( e ){
			delete e.attraction
		} )
	},


	layoutIteration: function() {
		// Forces on nodes due to node-node repulsions
		var nodelist = this.graph.vertices.values()
		for (var i = 0; i < nodelist.length; i++) {
			var node1 = nodelist[i]
			for (var j = i + 1; j < nodelist.length; j++) {
				var node2 = nodelist[j]
				this.layoutRepulsive(node1, node2)
			}
		}
		// Forces on nodes due to edge attractions
		for ( i = 0; i < this.graph.edges.length; i++) {
			var edge = this.graph.edges[i]
			this.layoutAttractive(edge)             
		}
  
		// Move by the given force
		for ( i = 0 ; i < nodelist.length; i ++) {
			var node = nodelist[i]
			var xmove = this.c * node.layoutForceX
			var ymove = this.c * node.layoutForceY

			var max = this.maxVertexMovement
			if(xmove > max) xmove = max
			if(xmove < -max) xmove = -max
			if(ymove > max) ymove = max
			if(ymove < -max) ymove = -max

			node.layout_pos_x += xmove
			node.layout_pos_y += ymove
			node.layoutForceX = 0
			node.layoutForceY = 0
		}
	},

	layoutRepulsive: function(node1, node2) {
		var dx = node2.layout_pos_x - node1.layout_pos_x
		var dy = node2.layout_pos_y - node1.layout_pos_y
		var d2 = dx * dx + dy * dy
		if(d2 < 0.01) {
			dx = 0.1 * Math.random() + 0.1
			dy = 0.1 * Math.random() + 0.1
			d2 = dx * dx + dy * dy
		}
		var d = Math.sqrt(d2)
		if(d < this.maxRepulsiveForceDistance) {
			var repulsiveForce = this.k * this.k / d
			node2.layoutForceX += repulsiveForce * dx / d
			node2.layoutForceY += repulsiveForce * dy / d
			node1.layoutForceX -= repulsiveForce * dx / d
			node1.layoutForceY -= repulsiveForce * dy / d
		}
	},

	layoutAttractive: function(edge) {
		var node1 = edge.v1
		var node2 = edge.v2

		var dx = node2.layout_pos_x - node1.layout_pos_x
		var dy = node2.layout_pos_y - node1.layout_pos_y
		var d2 = dx * dx + dy * dy
		if(d2 < 0.01) {
			dx = 0.1 * Math.random() + 0.1
			dy = 0.1 * Math.random() + 0.1
			d2 = dx * dx + dy * dy
		}
		var d = Math.sqrt(d2)
		if(d > this.maxRepulsiveForceDistance) {
			d = this.maxRepulsiveForceDistance
			d2 = d * d
		}
		var attractiveForce = (d2 - this.k * this.k) / this.k
		if(edge.attraction == undefined || edge.attraction < 1) edge.attraction = 1
		attractiveForce *= Math.log(edge.attraction) * 0.5 + 1

		node2.layoutForceX -= attractiveForce * dx / d
		node2.layoutForceY -= attractiveForce * dy / d
		node1.layoutForceX += attractiveForce * dx / d
		node1.layoutForceY += attractiveForce * dy / d
	}
}
