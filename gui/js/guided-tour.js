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
    var ADVANCED_STEPS = [
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
            body: 'Once you set an exposure and outcome, DAGitty checks which variables are sufficient to ' +
                  '<strong>adjust for</strong> under your diagram, and whether your current choice works. ' +
                  'The answer depends on the causal assumptions you draw; it does not verify those assumptions.'
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
                  '<em>File → Open model file…</em> (or just drag the file onto the page). ' +
                  '<em>File → Copy shareable link</em> packs the whole diagram into a URL — nothing is uploaded anywhere. ' +
                  'Browser autosave can also restore your diagram when storage is available. Download a copy for a durable record.'
        },
        {
            target: '#btn-beginner-mode',
            title: 'You’re ready',
            body: 'New to this? <strong>Beginner mode</strong> hides the advanced panels. The <strong>Examples</strong> menu ' +
                  'has ready-made diagrams to explore. Re-open this tour any time from <em>Help → Tour the interface</em>.'
        }
    ];

    var BEGINNER_STEPS = [
        {
            target: '#beginner-cause',
            title: 'Choose your question',
            body: 'Choose the possible cause and the result you care about. DAGitty will check the overall effect, including effects through other variables.'
        },
        {
            target: '#beginner-edit',
            title: 'Review your assumptions',
            body: 'Each arrow shows a possible direct effect. Use <strong>Edit variables and arrows</strong> to review or change them, or <strong>Build step by step</strong> to start a new diagram.'
        },
        {
            target: '#beginner-verdict',
            title: 'Choose your controls',
            body: 'Check which variables to control for under the assumptions in your diagram. If a complete set is available, you can apply it and undo that choice from the toolbar.'
        },
        {
            target: '#beginner-save',
            title: 'Save and discuss',
            body: 'Save an editable diagram, share a link or export a figure. Discuss your choice of variables and arrows with someone who knows the subject.'
        },
        {
            target: '#btn-beginner-mode',
            title: 'Explore the full editor',
            body: 'Switch to the full editor when you need more analysis options. You can return to this tour from <strong>Help → Tour the interface</strong>.'
        }
    ];

    var idx = 0, active = false;
    var steps = ADVANCED_STEPS, opener = null;
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
        var step = steps[idx];
        els.title.innerHTML = step.title;
        els.body.innerHTML = step.body;
        els.progress.textContent = 'Step ' + (idx + 1) + ' of ' + steps.length;
        els.back.style.visibility = idx === 0 ? 'hidden' : 'visible';
        els.next.textContent = idx === steps.length - 1 ? 'Done' : 'Next';
        if (idx === 0 && document.activeElement === els.back) els.next.focus();

        var target = step.target ? document.querySelector(step.target) : null;
        if (target && target.getClientRects().length) {
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

    function next() { if (idx < steps.length - 1) { idx++; show(); } else { end(); } }
    function back() { if (idx > 0) { idx--; show(); } }

    function onKey(e) {
        if (!active) return;
        if (e.key === 'Escape') { e.preventDefault(); end(); }
        else if (e.key === 'Tab') {
            var buttons = Array.from(els.card.querySelectorAll('button')).filter(function (button) {
                return getComputedStyle(button).visibility !== 'hidden';
            });
            var first = buttons[0], last = buttons[buttons.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    }
    function onReflow() { if (active) show(); }

    function start() {
        if (active) return;
        build();
        opener = document.activeElement;
        steps = document.body.classList.contains('beginner-mode') && document.getElementById('beginner-cause')
            ? BEGINNER_STEPS : ADVANCED_STEPS;
        idx = 0;
        active = true;
        els.root.classList.add('on');
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onReflow);
        show();
        els.next.focus({ preventScroll: true });
    }

    function end() {
        if (!active) return;
        active = false;
        if (els.root) els.root.classList.remove('on');
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onReflow);
        if (!opener || !opener.getClientRects().length) {
            var submenu = opener && opener.closest('#menu ul');
            opener = submenu ? submenu.previousElementSibling : document.getElementById('btn-build-dag');
        }
        if (opener) opener.focus();
        opener = null;
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
