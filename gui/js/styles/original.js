(function(){ 
DAGitty.stylesheets.original = {
			style : {
				node : {
					'd' : 'M 0 0 m 20, 0 a 20,15 0 1,1 -40,0 a 20,15 0 1,1 40,0',
					fill: "#aaaaaa",
					stroke : "#666666",
				},
				exposurenode : { fill : "#bed403", stroke : "#000000" },
				outcomenode : { fill : "#00a2e0", stroke : "#000000" },
				adjustednode : { fill : "#ffffff", stroke : "#000000" },
				selectednode : { 'd' : 'M  20, 0 L 20,15 L -20,15 L -20,-15 L 20,-15 Z' },
				latentnode : {  fill : "#dddddd", stroke: "#aaaaaa" /*"stroke-dasharray" : "5,5" */},
				confoundernode : { fill : "#ff7777", stroke : "#ff7777" },
				anexposurenode : { fill : "#bed403", stroke : "#bed403" },
				anoutcomenode : { fill : "#00a2e0", stroke : "#00a2e0" },
				nodelabel : { y: 35, "text-anchor" : "middle" },
				nodelabelbg : { fill: "#ffffff" },
				path : { stroke : "black", "stroke-width": 1.5, fill : "none" },
				causalpath : { stroke : "#4dac26" },
				biasingpath : { stroke : "#d01c8b" },
				puredirectpath_inactive : { "stroke-width": 3 }
			},
			decoration : {
				exposurenode : [ {text:"E", "class":"node-role", "aria-label":"Exposure", x:0, y:0, dy:".35em", "text-anchor":"middle", "font-size":12, "font-weight":"bold", fill:"#000000", stroke:"none"} ],
				outcomenode : [ {text:"O", "class":"node-role", "aria-label":"Outcome", x:0, y:0, dy:".35em", "text-anchor":"middle", "font-size":12, "font-weight":"bold", fill:"#000000", stroke:"none"} ],
				adjustednode : [ {text:"A", "class":"node-role", "aria-label":"Adjusted", x:0, y:0, dy:".35em", "text-anchor":"middle", "font-size":12, "font-weight":"bold", fill:"#000000", stroke:"none"} ],
				directedpath : [ { 'class' : "arrowfront", 'd': "M-1,0L15,5L15,-5Z", fill : "white" } ],
				bidirectedpath : [
					{ 'class' : "arrowfront", 'd': "M-1,0L15,5L15,-5Z", fill : "white" },
					{ 'class' : "arrowback", 'd': "M-1,0L15,5L15,-5Z", fill : "white" }
				]
			}
	};
	DAGitty.stylesheets.default = DAGitty.stylesheets.original
})();
