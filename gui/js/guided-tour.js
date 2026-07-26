/* DAGitty — Guided Tour
 *
 * A small, dependency-free onboarding tour for people new to causal diagrams.
 * Spotlights parts of the UI with plain-language explanations. Augments the
 * GUI without modifying main.js.
 */

(function () {
    'use strict';

    var STORE_KEY = 'dagitty_tour_done';

    // ── Steps ─────────────────────────────────────────────────────────────────
    // target: CSS selector to spotlight (null = centered, no spotlight)
    var STEPS = [
        {
            target: null,
            title: 'Welcome to DAGitty 👋',
            body: 'A <strong>causal diagram</strong> (a DAG) is a picture of what you believe causes what. ' +
                  'This 60-second tour shows how to build one and read what it tells you. You can leave any time.'
        },
        {
            target: '#canvas',
            title: 'The canvas',
            body: 'This is where you draw. <strong>Click an empty spot</strong> to add a variable. ' +
                  '<strong>Click one variable, then another</strong> to draw an arrow — an arrow X→Y means ' +
                  '“X directly causes Y”. Drag a variable to move it.'
        },
        {
            target: '#variable',
            title: 'Give each variable a role',
            body: 'Select a variable to mark its role here: <strong>exposure</strong> (the cause you’re studying), ' +
                  '<strong>outcome</strong> (the effect), <strong>adjusted</strong> (something you control for in your ' +
                  'analysis), or <strong>unobserved</strong> (real but unmeasured).'
        },
        {
            target: '#diagram_check',
            title: 'Catch mistakes early',
            body: 'This panel names the specific problems in your diagram in plain language — controlling for a ' +
                  '<strong>mediator</strong> or a <strong>collider</strong>, an arrow drawn the wrong way round, ' +
                  'selecting your sample on a common effect. These are the mistakes that quietly bias real studies.'
        },
        {
            target: '#causal_effect_block',
            title: 'What must you control for?',
            body: 'The payoff: once you set an exposure and outcome, DAGitty tells you exactly which variables you must ' +
                  '<strong>adjust for</strong> to estimate the effect without bias — and whether your current choice works.'
        },
        {
            target: '#testable_implications',
            title: 'Predictions you can test',
            body: 'Your diagram implies statistical patterns (conditional independencies) that should hold in your data. ' +
                  'If they don’t, the model may be wrong — a free sanity check on your assumptions.'
        },
        {
            target: '#methods_block',
            title: 'Assumptions for your paper',
            body: 'One click turns your diagram into a <strong>plain-language statement of the assumptions</strong> needed ' +
                  'to read your result as causal — ready to paste into a methods or limitations section. Copy it from here.'
        },
        {
            target: '#model_data',
            title: 'Save, share, reproduce',
            body: 'Your model is plain text. <strong>Download</strong> it here and reopen it later with ' +
                  '<em>Model → Open model file…</em> (or just drag the file onto the page). ' +
                  '<em>Model → Copy shareable link</em> packs the whole diagram into a URL — nothing is uploaded anywhere. ' +
                  'Your work is also saved in this browser automatically, so a reload will not lose it.'
        },
        {
            target: '#btn-beginner-mode',
            title: 'You’re ready',
            body: 'New to this? <strong>Beginner mode</strong> hides the advanced panels. The <strong>Examples</strong> menu ' +
                  'has ready-made diagrams to explore. Re-open this tour any time from <em>Help → Interactive tutorial</em>.'
        }
    ];

    var idx = 0, active = false;
    var els = {};

    function build() {
        if (els.root) return;
        var root = document.createElement('div');
        root.id = 'tour-root';
        root.innerHTML =
            '<div id="tour-backdrop"></div>' +
            '<div id="tour-spot"></div>' +
            '<div id="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">' +
              '<button id="tour-x" aria-label="Close tour" title="Close">✕</button>' +
              '<p id="tour-title"></p>' +
              '<p id="tour-body"></p>' +
              '<div id="tour-foot">' +
                '<span id="tour-progress"></span>' +
                '<span id="tour-btns">' +
                  '<button id="tour-skip" class="tour-ghost">Skip</button>' +
                  '<button id="tour-back" class="tour-ghost">Back</button>' +
                  '<button id="tour-next">Next</button>' +
                '</span>' +
              '</div>' +
            '</div>';
        document.body.appendChild(root);
        els.root = root;
        els.spot = document.getElementById('tour-spot');
        els.card = document.getElementById('tour-card');
        els.title = document.getElementById('tour-title');
        els.body = document.getElementById('tour-body');
        els.progress = document.getElementById('tour-progress');
        els.next = document.getElementById('tour-next');
        els.back = document.getElementById('tour-back');

        document.getElementById('tour-next').addEventListener('click', next);
        document.getElementById('tour-back').addEventListener('click', back);
        document.getElementById('tour-skip').addEventListener('click', end);
        document.getElementById('tour-x').addEventListener('click', end);
        document.getElementById('tour-backdrop').addEventListener('click', function (e) { e.stopPropagation(); });
    }

    function show() {
        var step = STEPS[idx];
        els.title.innerHTML = step.title;
        els.body.innerHTML = step.body;
        els.progress.textContent = 'Step ' + (idx + 1) + ' of ' + STEPS.length;
        els.back.style.visibility = idx === 0 ? 'hidden' : 'visible';
        els.next.textContent = idx === STEPS.length - 1 ? 'Done' : 'Next';

        var target = step.target ? document.querySelector(step.target) : null;
        if (target && target.offsetParent !== null) {
            // scrollIntoView updates layout synchronously, so we can measure and
            // position immediately — no requestAnimationFrame (which can be
            // throttled in background/headless tabs and leave the spotlight hidden).
            try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            positionAt(target);
        } else {
            positionCenter();
        }
    }

    function positionAt(target) {
        var r = target.getBoundingClientRect();
        var pad = 6;
        els.spot.style.display = 'block';
        els.spot.style.top = (r.top - pad) + 'px';
        els.spot.style.left = (r.left - pad) + 'px';
        els.spot.style.width = (r.width + pad * 2) + 'px';
        els.spot.style.height = (r.height + pad * 2) + 'px';

        // Measure card
        els.card.style.visibility = 'hidden';
        els.card.style.display = 'block';
        var cw = els.card.offsetWidth, ch = els.card.offsetHeight;
        var vw = window.innerWidth, vh = window.innerHeight;
        var gap = 14, top, left;

        if (r.bottom + gap + ch <= vh) {            // below
            top = r.bottom + gap; left = r.left;
        } else if (r.top - gap - ch >= 0) {          // above
            top = r.top - gap - ch; left = r.left;
        } else if (r.right + gap + cw <= vw) {       // right
            left = r.right + gap; top = (vh - ch) / 2;
        } else if (r.left - gap - cw >= 0) {         // left
            left = r.left - gap - cw; top = (vh - ch) / 2;
        } else {                                     // overlay-centered fallback
            top = (vh - ch) / 2; left = (vw - cw) / 2;
        }
        left = Math.max(8, Math.min(left, vw - cw - 8));
        top  = Math.max(8, Math.min(top,  vh - ch - 8));
        els.card.style.top = top + 'px';
        els.card.style.left = left + 'px';
        els.card.style.visibility = 'visible';
    }

    function positionCenter() {
        els.spot.style.display = 'none';
        els.card.style.visibility = 'hidden';
        els.card.style.display = 'block';
        var cw = els.card.offsetWidth, ch = els.card.offsetHeight;
        els.card.style.top = Math.max(8, (window.innerHeight - ch) / 2) + 'px';
        els.card.style.left = ((window.innerWidth - cw) / 2) + 'px';
        els.card.style.visibility = 'visible';
    }

    function next() { if (idx < STEPS.length - 1) { idx++; show(); } else { end(); } }
    function back() { if (idx > 0) { idx--; show(); } }

    function onKey(e) {
        if (!active) return;
        if (e.key === 'Escape') { e.preventDefault(); end(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    }
    function onReflow() { if (active) show(); }

    function start() {
        build();
        idx = 0;
        active = true;
        els.root.classList.add('on');
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onReflow);
        show();
    }

    function end() {
        active = false;
        if (els.root) els.root.classList.remove('on');
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onReflow);
        try { localStorage.setItem(STORE_KEY, '1'); } catch (e) {}
    }

    // ── First-run prompt ──────────────────────────────────────────────────────
    function maybePrompt() {
        var seen;
        try { seen = localStorage.getItem(STORE_KEY); } catch (e) { seen = '1'; }
        if (seen) return;
        var p = document.createElement('div');
        p.id = 'tour-prompt';
        p.innerHTML =
            '<span class="tp-wave">👋</span>' +
            '<span class="tp-txt">New to causal diagrams? Build your first one step by step.</span>' +
            '<button id="tp-build">Build a DAG</button>' +
            '<button id="tp-start" class="tour-ghost">Just tour the interface</button>' +
            '<button id="tp-later" class="tour-ghost">Maybe later</button>';
        document.body.appendChild(p);
        var dismiss = function () { try { localStorage.setItem(STORE_KEY, '1'); } catch (e) {} };
        var buildBtn = document.getElementById('tp-build');
        if (buildBtn) buildBtn.addEventListener('click', function () {
            p.remove(); dismiss();
            if (window.DagWizard) DagWizard.start(); else start();
        });
        document.getElementById('tp-start').addEventListener('click', function () { p.remove(); start(); });
        document.getElementById('tp-later').addEventListener('click', function () { p.remove(); dismiss(); });

        hideWhileModalOpen(p);
    }

    /**
     * The prompt is a fixed pill at the bottom of the screen — exactly where the
     * dialogs put their footer buttons. A first-time visitor who opened
     * "Generate DAG from data…" straight away could not click Run Analysis,
     * because the prompt sat on top of it. Get it out of the way whenever a
     * dialog is open, and bring it back afterwards (without marking it as seen,
     * since they never answered it).
     */
    function hideWhileModalOpen(p) {
        var modals = document.querySelectorAll('.modal-overlay');
        if (!modals.length || typeof MutationObserver === 'undefined') return;
        var sync = function () {
            var open = Array.prototype.some.call(modals, function (m) {
                return getComputedStyle(m).display !== 'none';
            });
            p.style.display = open ? 'none' : '';
        };
        var obs = new MutationObserver(sync);
        Array.prototype.forEach.call(modals, function (m) {
            obs.observe(m, { attributes: true, attributeFilter: ['style', 'class'] });
        });
        sync();
    }

    window.GuidedTour = { start: start, end: end };

    window.addEventListener('load', function () {
        setTimeout(maybePrompt, 600);
    });

})();
