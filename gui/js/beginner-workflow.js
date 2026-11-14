/* Guided workspace; all edits use the same graph and analysis as the full editor. */
(function () {
    'use strict';
    var lastMode = null, advanced = null, notice = '';
    var panels = ['quickstart','variable','analysis_setup','model_data','viewmode','effects','dagstyle','coloring','legend',
        'diagram_check','causal_effect_block','paths_panel','testable_implications_block','methods_block','summary'];
    var highlights = [['highlight_ancestral','set_highlight_ancestors'],['highlight_causal','set_highlight_causal'],['highlight_biasing','set_highlight_biasing']];
    function $(id) { return document.getElementById(id); }
    function graph() { return window.Model && Model.dag; }
    function ids(vs) { return vs.map(function (v) { return v.id; }).sort(); }
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function equal(a,b) { var x=a.slice().sort(), y=b.slice().sort(); return x.length===y.length && x.every(function(v,i){return v===y[i];}); }
    function pending() { return !!($('adj_matrix') && $('adj_matrix').classList.contains('dirty')); }
    function say(s) { notice=s; if($('beginner-notice')) $('beginner-notice').textContent=s; }
    function supported(g) {
        return !!(g && g.getType()==='dag' && !GraphAnalyzer.containsCycle(g) && g.getSources().length===1 &&
            g.getTargets().length===1 && g.getSources()[0].id!==g.getTargets()[0].id);
    }
    function available(g,id) { var v=g.getVertex(id); return !!(v && !g.isSource(v) && !g.isTarget(v) && !g.isLatentNode(v) && !g.isSelectedNode(v)); }
    function canEdit() {
        if(pending() || window.modelCodeIsPending && modelCodeIsPending()) {
            say('You have unapplied model code. Switch to the full editor to apply or clear the draft first.'); return false;
        }
        return !!(graph() && window.DAGittyControl);
    }
    function install(g) {
        if(window.UndoRedo) UndoRedo.push();
        notice=''; DAGittyControl.setGraph(g);
        if(window.UndoRedo) UndoRedo.push();
        refresh();
    }
    function applyControls(chosen,validate) {
        var g=graph(); if(!canEdit()) return false;
        if(!supported(g) || !Array.isArray(chosen) || chosen.some(function(id){return typeof id!=='string' || !available(g,id);})) {
            say('Choose measured variables from this diagram. Use the full editor for specialised graphs or questions.'); return false;
        }
        var next=g.clone();
        next.getAdjustedNodes().slice().forEach(function(v){next.removeAdjustedNode(v);});
        Array.from(new Set(chosen)).forEach(function(id){next.addAdjustedNode(next.getVertex(id));});
        if(validate && !GraphAnalyzer.isAdjustmentSet(next)) {
            say('The diagram has changed and that set is no longer sufficient. Review the updated advice.'); return false;
        }
        install(next); return true;
    }
    function chooseRole(source,id) {
        var g=graph(); if(!canEdit()){refresh();return;}
        var v=g.getVertex(id), opposite=source?g.getTargets():g.getSources();
        if(!v || g.isLatentNode(v) || g.isSelectedNode(v) || opposite.some(function(o){return o.id===id;})) {
            say('Choose two different, measured variables for the possible cause and result.'); refresh(); return;
        }
        var next=g.clone();
        (source?next.getSources():next.getTargets()).slice().forEach(function(old){
            if(source) next.removeSource(old); else next.removeTarget(old);
        });
        if(source) next.addSource(next.getVertex(id)); else next.addTarget(next.getVertex(id));
        next.removeAdjustedNode(next.getVertex(id)); install(next);
    }
    function strategy(value) {
        var input=$('causal_effect_kind');
        if(input && input.value!==value) {input.value=value;input.dispatchEvent(new window.Event('change',{bubbles:true}));}
    }
    function supportedStrategy(value) {
        var g=graph(); if(!g) return value==='adj_total';
        if(value==='adj_direct') return g.getType()==='dag' && !g.getSelectedNodes().length;
        if(value==='adj_causalodds') return g.getType()==='dag' && g.getSources().length===1 && g.getTargets().length===1 && g.getSelectedNodes().length===1;
        return value==='adj_total' || value==='instrument' && g.getType()==='dag';
    }
    function mode() {
        if(!$('beginner-setup') || !window.BeginnerMode) return;
        var active=BeginnerMode.active;
        if(active!==lastMode) {
            if(active) {
                var view=document.querySelector('input[name="dagview"]:checked');
                advanced={effect:$('causal_effect_kind')?$('causal_effect_kind').value:'adj_total',view:view?view.value:'normal',highlights:[]};
                try {
                    if(lastMode===null && localStorage.getItem(BeginnerMode.KEY)==='true') advanced.effect=localStorage.getItem('dagitty_advanced_effect')||advanced.effect;
                    localStorage.setItem('dagitty_advanced_effect',advanced.effect);
                } catch(e) {}
                highlights.forEach(function(pair){
                    var input=$(pair[0]); advanced.highlights.push(input?input.checked:null);
                    if(input && window.GUI && GUI[pair[1]]) {input.checked=false;GUI[pair[1]](false);}
                });
                if(window.GUI && GUI.set_view_mode && $('dagview_normal')) GUI.set_view_mode('normal');
                strategy('adj_total');
            } else if(advanced) {
                highlights.forEach(function(pair,i){
                    var input=$(pair[0]), value=advanced.highlights[i];
                    if(input && value!==null && window.GUI && GUI[pair[1]]) {input.checked=value;GUI[pair[1]](value);}
                });
                if(window.GUI && GUI.set_view_mode && $('dagview_'+advanced.view)) GUI.set_view_mode(advanced.view);
                strategy(supportedStrategy(advanced.effect)?advanced.effect:'adj_total');
            }
            lastMode=active;
        }
        refresh();
    }
    function populate(select,g,source) {
        var marked=source?g.getSources():g.getTargets();
        var html='<option value="">'+(marked.length>1?'Multiple variables — choose one':'Choose a variable')+'</option>';
        g.getVertices().slice().sort(function(a,b){return a.id.localeCompare(b.id);}).forEach(function(v){
            html+='<option value="'+esc(v.id)+'"'+(g.isLatentNode(v)||g.isSelectedNode(v)?' disabled':'')+'>'+esc(v.id)+'</option>';
        });
        if(select.innerHTML!==html) select.innerHTML=html;
        select.value=marked.length===1?marked[0].id:''; select.disabled=pending()||!g.getVertices().length;
    }
    function option(host,set,current) {
        var row=document.createElement('div'); row.className='beginner-option';
        var text=document.createElement('p');text.textContent=set.length?set.join(', '):'No additional control variables';row.appendChild(text);
        var button=document.createElement('button');button.type='button';button.dataset.focusKey='set:'+JSON.stringify(set);
        button.textContent=equal(set,current)?'Already using this set':set.length?'Use these controls':'Use no controls';
        button.disabled=pending()||equal(set,current);button.addEventListener('click',function(){applyControls(set,true);});
        row.appendChild(button);host.appendChild(row);
    }
    function checks() {
        var host=$('beginner-checks');host.replaceChildren();if(!window.DiagramCheck)return;
        var items=DiagramCheck.analyse().filter(function(f){return f.level==='error'||f.level==='warn';});
        var details=document.createElement('details'),summary=document.createElement('summary');
        summary.textContent=items.length?'Review diagram checks ('+items.length+')':'About these checks';details.appendChild(summary);
        if(items.length) {
            var ul=document.createElement('ul');items.forEach(function(f){var li=document.createElement('li');li.textContent=(f.subject||'')+f.text;ul.appendChild(li);});details.appendChild(ul);
        } else {
            var p=document.createElement('p');p.textContent='No common diagram problems were found. This does not establish that your arrows or causal assumptions are correct.';details.appendChild(p);
        }
        host.appendChild(details);
    }
    function refresh() {
        if(!$('beginner-setup') || !window.BeginnerMode || !BeginnerMode.active)return;
        var g=graph();if(!g)return;
        var focus=document.activeElement&&document.activeElement.dataset.focusKey;
        populate($('beginner-cause'),g,true);populate($('beginner-result'),g,false);
        var valid=supported(g),current=ids(g.getAdjustedNodes()),verdict=$('beginner-verdict'),explanation=$('beginner-explanation'),host=$('beginner-options');
        $('beginner-draft').hidden=!pending();host.replaceChildren();verdict.className='beginner-verdict';
        $('beginner-question').textContent=valid?'What is the overall effect of '+g.getSources()[0].id+' on '+g.getTargets()[0].id+'?':'Choose one possible cause and one result.';
        $('beginner-chosen').textContent='Your current controls: '+(current.length?current.join(', '):'none')+'.';
        if(GraphAnalyzer.containsCycle(g)) {
            verdict.textContent='An arrow loop needs fixing first.';explanation.textContent='A causal DAG cannot loop back to the same variable. Review the arrows in your diagram.';
        } else if(g.getType()!=='dag') {
            verdict.textContent='This diagram needs the full editor.';explanation.textContent='The simplified view handles DAGs. Use the full editor to review uncertain directions or other graph types.';
        } else if(!valid) {
            verdict.textContent='Start with your question.';explanation.textContent='Choose one possible cause and one result, or build a diagram step by step. Use the full editor for joint effects involving several causes or results.';
        } else {
            var sets=window.AdjustmentSets?AdjustmentSets.minimal(g,'total'):null,sufficient=GraphAnalyzer.isAdjustmentSet(g);
            verdict.classList.add(sufficient?'beginner-ok':'beginner-review');
            verdict.textContent=sufficient?'Your controls are sufficient under this diagram.':'Your current controls are not sufficient under this diagram.';
            if(sets===null) explanation.textContent='Adjustment advice is unavailable for this question. Review it in the full editor.';
            else if(!sets.length) explanation.textContent='No set of measured controls can identify the overall effect by adjustment under these assumptions. Review the assumptions and study design; the full editor offers other analysis strategies.';
            else {
                sets=sets.slice().sort(function(a,b){return a.length-b.length||a.join('\u0000').localeCompare(b.join('\u0000'));});
                explanation.textContent=sets[0].length?'One complete option is below. Use exactly the listed variables; adding extra controls can introduce bias.':'No additional controls are needed under these assumptions. The button clears the ordinary controls you have marked.';
                option(host,sets[0],current);
                if(sets.length>1) {
                    var details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Other valid options ('+(sets.length-1)+')';details.appendChild(summary);
                    sets.slice(1).forEach(function(set){option(details,set,current);});host.appendChild(details);
                }
            }
        }
        var selected=ids(g.getSelectedNodes()),latent=ids(g.getLatentNodes());
        $('beginner-special').textContent=(selected.length?'Selection nodes ('+selected.join(', ')+') remain conditioned on because they describe who is in the sample. ':'')+
            (latent.length?'Unmeasured variables ('+latent.join(', ')+') cannot be used as measured controls.':'');
        var controls=$('beginner-controls');controls.replaceChildren();
        g.getVertices().filter(function(v){return available(g,v.id);}).sort(function(a,b){return a.id.localeCompare(b.id);}).forEach(function(v){
            var label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.variable=v.id;input.dataset.focusKey='control:'+v.id;
            input.checked=g.isAdjustedNode(v);input.disabled=pending()||!valid;
            input.addEventListener('change',function(){applyControls(Array.from(controls.querySelectorAll('input:checked'),function(i){return i.dataset.variable;}),false);});
            label.appendChild(input);label.appendChild(document.createTextNode(v.id));controls.appendChild(label);
        });
        if(!controls.children.length)controls.textContent='There are no other measured variables to choose.';
        checks();$('beginner-notice').textContent=notice;
        if(focus) {
            var target=Array.from(document.querySelectorAll('[data-focus-key]')).find(function(e){return e.dataset.focusKey===focus;});
            if(target&&!target.disabled)target.focus();
        }
    }
    function init() {
        if(!$('beginner-setup')||!$('beginner-results')||!window.BeginnerMode)return;
        panels.forEach(function(id){var p=$(id);if(p)p.classList.add('advanced-only');var h=document.querySelector('h3[aria-controls="'+id+'"]');if(h)h.classList.add('advanced-only');});
        $('beginner-setup').innerHTML=
            '<section class="beginner-card"><p class="beginner-kicker">Beginner mode</p><h2>1. Your question</h2><p>What might cause a change in what?</p>'+
            '<label for="beginner-cause">Possible cause <span>(exposure)</span></label><select id="beginner-cause" data-focus-key="cause"></select>'+
            '<label for="beginner-result">Result you care about <span>(outcome)</span></label><select id="beginner-result" data-focus-key="result"></select>'+
            '<p class="beginner-note">We look at the overall effect, including effects through other variables.</p></section>'+
            '<section class="beginner-card"><h2>2. Build your assumptions</h2><p>Each arrow says one variable may directly affect another. The tool cannot decide whether that assumption is true.</p>'+
            '<button type="button" id="beginner-build">Build step by step</button><button type="button" id="beginner-edit" class="btn-secondary">Edit variables and arrows</button>'+
            '<button type="button" id="beginner-canvas" class="btn-secondary">View the diagram</button><p class="beginner-note">E marks the cause, O the result and A a control. Drag variables to move them.</p></section>'+
            '<section class="beginner-card"><button type="button" id="beginner-full" class="btn-secondary">Switch to the full editor</button></section>';
        $('beginner-results').innerHTML=
            '<section class="beginner-card"><h2>3. Choose your controls</h2><p id="beginner-question"></p>'+
            '<p id="beginner-draft" class="beginner-draft" role="alert" hidden>You have unapplied model code. Switch to the full editor to apply or clear it before changing the diagram.</p>'+
            '<p id="beginner-verdict" class="beginner-verdict" role="status"></p><p id="beginner-explanation"></p><p id="beginner-chosen"></p><div id="beginner-options"></div><p id="beginner-special" class="beginner-note"></p>'+
            '<details><summary>Try your own controls</summary><p>Tick variables you plan to control for, for example in a regression. The advice updates when you change them.</p><div id="beginner-controls"></div></details>'+
            '<div id="beginner-checks"></div><p id="beginner-notice" role="alert"></p><p class="beginner-note">This is advice about adjustment under your diagram, not proof of a causal effect. Missing causes, measurement problems and study design still matter.</p></section>'+
            '<section class="beginner-card"><h2>4. Save and discuss</h2><p>Share the diagram and its assumptions with someone who knows your topic.</p>'+
            '<div class="beginner-actions"><button type="button" id="beginner-save">Save diagram</button><button type="button" id="beginner-share" class="btn-secondary">Copy share link</button><button type="button" id="beginner-figure" class="btn-secondary">Save a figure</button></div></section>';
        $('beginner-cause').addEventListener('change',function(){chooseRole(true,this.value);});
        $('beginner-result').addEventListener('change',function(){chooseRole(false,this.value);});
        $('beginner-build').addEventListener('click',function(){if(window.DagWizard)DagWizard.start();});
        $('beginner-canvas').addEventListener('click',function(){if($('canvas')){$('canvas').scrollIntoView({block:'center'});$('canvas').focus();}});
        $('beginner-edit').addEventListener('click',function(){if(window.StructuredEditor)StructuredEditor.open();});
        $('beginner-full').addEventListener('click',function(){BeginnerMode.toggle();});
        $('beginner-save').addEventListener('click',function(){if(window.downloadModel)downloadModel();});
        $('beginner-share').addEventListener('click',function(){if(window.Workspace)Workspace.shareLink();});
        $('beginner-figure').addEventListener('click',function(){if(window.PubExport)PubExport.open();});
        window.addEventListener('dagitty:modechange',mode);
        if($('causal_effect_kind')) $('causal_effect_kind').addEventListener('change',function(){
            if(!BeginnerMode.active) {try{localStorage.setItem('dagitty_advanced_effect',this.value);}catch(e){}}
        });
        if(window.DAGittyControl)DAGittyControl.observe('graphchange',refresh);
        if($('adj_matrix')&&window.MutationObserver)new MutationObserver(refresh).observe($('adj_matrix'),{attributes:true,attributeFilter:['class']});
        var saved;try{saved=localStorage.getItem(BeginnerMode.KEY);}catch(e){saved=null;}
        if(saved==='false') {try{var effect=localStorage.getItem('dagitty_advanced_effect');if(effect&&supportedStrategy(effect))strategy(effect);}catch(e){}}
        if(saved!=='true'&&saved!=='false'){BeginnerMode.active=true;BeginnerMode._apply();}else mode();
    }
    window.BeginnerGuide={refresh:refresh,applySet:function(set){return applyControls(set,true);}};
    window.addEventListener('load',init);
})();

