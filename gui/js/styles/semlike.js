(function(){ 
	
var Base = {
	node : { 'd' : 'M [rx], 0 L [rx],[ry] L -[rx],[ry] L -[rx],-[ry] L [rx],-[ry] Z',
		stroke : "black", fill : "white", "stroke-width" : 1.5 },
	exposurenode : { 
		'd' : 'M [rx], 0 L [rx],[dy] L -[rx],[dy] L -[rx],-[ry] L [rx],-[ry] Z',
		fill : "#bed403", 
		stroke : "#000000" },
	outcomenode : { fill : "#00a2e0",
 		'd' : 'M [rx], 0 L [rx],[dy] L -[rx],[dy] L -[rx],-[ry] L [rx],-[ry] Z',
		stroke : "#000000" },
	adjustednode : { fill : "#cccccc",
		'd' : 'M [rx], 0 L [rx],[dy] L -[rx],[dy] L -[rx],-[ry] L [rx],-[ry] Z',
		stroke : "#000000" },
	latentnode : { 
		'd' : 'M 0 0 m [rx], 0 a [rx],[ry] 0 1,1 -[dx],0 a [rx],[ry] 0 1,1 [dx],0', stroke : "black" },
	confoundernode : { fill : "#ff7777",
		stroke : "#ff7777" },
	anexposurenode : { fill : "#bed403",
		stroke : "#bed403" },
	anoutcomenode : { fill : "#00a2e0",
		stroke : "#00a2e0" },
	nodelabel : { y: 0, dy : ".3em", "text-anchor": "middle"  },
	nodelabelbg : { "fill" : "none", "stroke" : "none"  }, 
	path : { stroke : "black", "fill" : "none" },
	causalpath : { stroke : "#4dac26" },
	biasingpath : { stroke : "#d01c8b" },
	puredirectpath_inactive : { "stroke-width": 3 },
}

var Decoration = {
	exposurenode : [ {text:"E", "class":"node-role", "aria-label":"Exposure", x:0, y:18, dy:".35em", "text-anchor":"middle", "font-size":12, "font-weight":"bold", fill:"#000000", stroke:"none" } ],
	outcomenode : [ {text:"O", "class":"node-role", "aria-label":"Outcome", x:0, y:18, dy:".35em", "text-anchor":"middle", "font-size":12, "font-weight":"bold", fill:"#000000", stroke:"none" } ],
	adjustednode : [ {text:"A", "class":"node-role", "aria-label":"Adjusted", x:0, y:18, dy:".35em", "text-anchor":"middle", "font-size":12, "font-weight":"bold", fill:"#000000", stroke:"none" } ],
	directedpath : [
		{ 'class' : "arrowfront", 'd': "M-1.5,0L5,5M-1.5,0L5,-5" }
	],
	bidirectedpath : [
		{ 'class' : "arrowfront", 'd': "M-1.5,0L5,5M-1.5,0L5,-5" },
		{ 'class' : "arrowback", 'd': "M-1.5,0L5,5M-1.5,0L5,-5" }
	]
}

DAGitty.stylesheets.semlike = { style : Base, decoration : Decoration };
DAGitty.stylesheets.default = DAGitty.stylesheets.semlike

})();
