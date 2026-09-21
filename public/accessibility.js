/* ════════════════════════════════════════════════════════════════════════════
   ACCESSIBILITY — SAFETY NET, NOT A SWEEP
   ────────────────────────────────────────────────────────────────────────────
   This file used to author the accessible markup at runtime: `for` attributes
   on orphaned labels, aria-label from a placeholder, role="button" and a
   keydown handler on every clickable div, tab wiring, dialog roles. It ran
   enhance() from a MutationObserver over document.body with subtree:true AND
   attributes:true, so every class toggle anywhere in the app re-ran the whole
   thing — on a screen that repaints as often as this one.

   Phase 2 step 7 moved all of that into the markup and the component library.
   What is left is the part that genuinely cannot live in markup — the modal
   focus trap, Escape, and returning focus — plus a net that catches anything
   the markup still misses.

   The net LOGS. In development every fix it makes is reported with the element
   that needed it, and collected on window.__a11yGaps, so the next person sees
   the markup gap instead of silently inheriting the patch. Anything appearing
   in that list is a bug in the markup, not a feature of this file.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  var generatedId = 0;
  var activeModal = null;
  var returnFocus = null;
  var modalSelector = '.hb-modal,.ql-modal,.photo-modal,.focus-overlay,.day-plan-overlay,.profile-menu';
  var focusableSelector = 'button:not([disabled]),a[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  // Dev = a local host, or ?a11y=debug on any build so the net can be read in
  // a deployed preview without shipping console noise to athletes.
  var DEBUG = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ||
    /(^|[?&])a11y=debug(&|$)/.test(location.search);
  var gaps = (window.__a11yGaps = []);
  function report(rule, element, detail) {
    var where = element && element.tagName
      ? element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') +
        (element.className && typeof element.className === 'string'
          ? '.' + element.className.trim().split(/\s+/).join('.') : '')
      : String(element);
    gaps.push({ rule: rule, element: where, detail: detail || '' });
    if (DEBUG) {
      console.warn('[a11y] ' + rule + ' had to be patched at runtime on ' + where +
        (detail ? ' — ' + detail : '') + '. This belongs in the markup.');
    }
  }

  function visible(element) {
    if (!element) return false;
    var style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  // ── NET 1 · unlabelled controls ───────────────────────────────────────────
  // Every <label> in index.html now carries `for`, and every generated control
  // carries its own aria-label. Anything this catches is a regression.
  function labelControls(root) {
    (root || document).querySelectorAll('label:not([for])').forEach(function (label) {
      var control = label.querySelector('input,select,textarea');
      if (!control) {
        var field = label.closest('.lf,.stat-field,.milestone-field,.run-field,.pain-log-block');
        if (field) control = field.querySelector('input,select,textarea');
      }
      if (!control) return;
      if (!control.id) control.id = 'dp-field-' + (++generatedId);
      label.htmlFor = control.id;
      report('label[for]', label, 'label wrapped or adjacent to ' + control.id);
    });

    (root || document).querySelectorAll('input,select,textarea').forEach(function (control) {
      if (control.type === 'hidden' || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return;
      if (control.id && document.querySelector('label[for="' + CSS.escape(control.id) + '"]')) return;
      var placeholder = control.getAttribute('placeholder');
      if (placeholder) control.setAttribute('aria-label', placeholder);
      report('accessible name', control, placeholder ? 'fell back to the placeholder' : 'has no name at all');
    });
  }

  // ── NET 2 · icon-only buttons ─────────────────────────────────────────────
  function labelIconButtons(root) {
    (root || document).querySelectorAll('button').forEach(function (button) {
      if (button.getAttribute('aria-label') || button.getAttribute('aria-labelledby') || button.textContent.trim()) return;
      report('accessible name', button, 'icon-only button with no aria-label');
    });
  }

  // ── The modal contract · genuinely runtime ────────────────────────────────
  // role/aria-modal/aria-labelledby are authored in the markup now. What is
  // left is state: which dialog is open, trapping Tab inside it, and putting
  // focus back where it came from. None of that can be static.
  function syncModalState() {
    var open = Array.from(document.querySelectorAll(modalSelector)).filter(function (modal) {
      return modal.classList.contains('open') && visible(modal);
    }).pop() || null;

    document.querySelectorAll(modalSelector).forEach(function (modal) {
      modal.setAttribute('aria-hidden', modal === open ? 'false' : 'true');
      if (!modal.getAttribute('role')) report('role="dialog"', modal, 'sheet is missing its dialog role in the markup');
    });

    if (open && open !== activeModal) {
      returnFocus = document.activeElement;
      activeModal = open;
      setTimeout(function () {
        var first = open.querySelector(focusableSelector);
        if (first) first.focus();
      }, 30);
    } else if (!open && activeModal) {
      activeModal = null;
      if (returnFocus && document.contains(returnFocus) && visible(returnFocus)) returnFocus.focus();
      returnFocus = null;
    }
  }

  document.addEventListener('keydown', function (event) {
    if (!activeModal) return;
    if (event.key === 'Escape') {
      var close = activeModal.querySelector('[aria-label^="Close"],.focus-close,.day-plan-close,.profile-menu-close');
      if (close) {
        event.preventDefault();
        close.click();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    var controls = Array.from(activeModal.querySelectorAll(focusableSelector)).filter(visible);
    if (!controls.length) return;
    var first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  function net(root) {
    labelControls(root);
    labelIconButtons(root);
  }

  net(document);
  syncModalState();

  // ── Observation, narrowed ─────────────────────────────────────────────────
  // Was: document.body, subtree:true, attributes:true — so a class toggle
  // anywhere re-ran every rule over the whole document. Now: the mounts that
  // actually receive innerHTML, childList only, for the net; and a separate
  // class-only watch on the sheet roots, which is the one attribute that
  // changes what syncModalState has to do.
  var RENDER_ROOTS = ['todayEl', 'calEl', 'callsSurface', 'logSheetBody', 'checkinModalBody',
    'hbModalBody', 'angleGrid', 'photoGrid', 'trainingVolumeStrip', 'weeklyVolumeStrip'];
  var netObserver = new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) net(node);
      });
    });
  });
  RENDER_ROOTS.forEach(function (id) {
    var mount = document.getElementById(id);
    if (mount) netObserver.observe(mount, { childList: true, subtree: true });
  });

  var modalObserver = new MutationObserver(syncModalState);
  document.querySelectorAll(modalSelector).forEach(function (modal) {
    modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  if (DEBUG) {
    setTimeout(function () {
      if (gaps.length) {
        console.warn('[a11y] ' + gaps.length + ' markup gap(s) still patched at runtime. ' +
          'window.__a11yGaps has the list.');
      } else {
        console.info('[a11y] no runtime patching needed — the markup carries its own semantics.');
      }
    }, 3000);
  }
})();
