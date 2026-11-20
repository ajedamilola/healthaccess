(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const slides = [...document.querySelectorAll('.slide')];
  const viewport = $('#viewport');
  const dialogs = [...document.querySelectorAll('dialog')];
  let current = 0;
  let touchStart = null;
  let channel = 'ussd';
  let demoStep = 0;
  let resizeFrame = 0;
  let lastDialogTrigger = null;
  let activeScreen = 'overview';

  const ussdSteps = [
    {
      lines: ['HealthAccess', '1. Find nearby care', '2. Emergency summary', '3. View shared details', '4. Emergency help', '0. Exit'],
      input: '1', prompt: 'Select an option',
      title: 'Choose. Enter an area. See a match.',
      description: 'A short, guided menu using the approved care directory.',
    },
    {
      lines: ['Choose a service', '1. General care', '2. Child health', '3. Maternity', '0. Back'],
      input: '2', prompt: 'Choose a service',
      title: 'Start with the care you need.',
      description: 'For this example, Ada chooses child health services.',
    },
    {
      lines: ['Where do you need care?', '', 'Enter an area, town', 'or city.', '', '0. Back'],
      input: 'Ikeja', prompt: 'Enter an area',
      title: 'Tell us where to look.',
      description: 'A location gives the search a practical starting point.',
    },
    {
      lines: ['DEMO RESULT', 'Demo Child Health Clinic', 'Service: Pediatrics', 'Area: Ikeja', '', 'Confirm details before travel.'],
      input: '0', prompt: 'Back to menu',
      title: 'A clearer next step.',
      description: 'Facility details help the patient decide who to contact. This is a demo listing.',
    },
  ];

  const smsSteps = [
    {
      outgoing: 'FIND pediatrics near Ikeja', incoming: '',
      title: 'Start with a simple text.',
      description: 'Name the kind of care and the area you want to search.',
    },
    {
      outgoing: 'FIND pediatrics near Ikeja', incoming: 'DEMO: Demo Child Health Clinic. Pediatrics. Area: Ikeja.',
      title: 'Get a useful care result.',
      description: 'The SMS flow resolves the service and area, then returns a matching listing.',
    },
    {
      outgoing: 'MORE', incoming: 'No more demo results. Confirm details with the facility before travelling.',
      title: 'Continue at your own pace.',
      description: 'MORE requests another stored result while the conversation is active.',
    },
    {
      outgoing: 'STOP', incoming: 'You have opted out. Pending replies are suppressed.',
      title: 'The patient controls the interaction.',
      description: 'STOP ends the interaction and opts out of pending replies.',
    },
  ];

  function fitStage() {
    const rect = viewport.getBoundingClientRect();
    const style = getComputedStyle(viewport);
    const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    document.documentElement.style.setProperty('--scale', String(Math.max(0.1, Math.min(width / 1600, height / 900))));
  }

  function scheduleFit() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fitStage);
  }

  function updateNotes() {
    $('#notes-slide-number').textContent = `${String(current + 1).padStart(2, '0')} / ${slides.length}`;
    $('#notes-title').textContent = slides[current].dataset.title;
    $('#notes-content').textContent = slides[current].querySelector('.speaker-note').textContent;
  }

  function showSlide(index, updateHash = true) {
    const next = Math.min(slides.length - 1, Math.max(0, index));
    // Move focus out of a slide before making that slide inert.
    if (next !== current && slides[current].contains(document.activeElement)) $('#next').focus();
    current = next;
    slides.forEach((slide, i) => {
      slide.classList.toggle('is-active', i === current);
      slide.inert = i !== current;
      slide.setAttribute('aria-hidden', String(i !== current));
    });
    $('#current-number').textContent = String(current + 1).padStart(2, '0');
    $('#chapter-label').textContent = slides[current].dataset.chapter;
    $('#previous').disabled = current === 0;
    $('#next').disabled = current === slides.length - 1;
    $('#progress-fill').style.width = `${((current + 1) / slides.length) * 100}%`;
    $('.deck-progress').setAttribute('aria-valuenow', String(current + 1));
    $('#slide-counter').setAttribute('aria-label', `Slide ${current + 1} of ${slides.length}. Open slide overview.`);
    document.title = `HealthAccess — ${slides[current].dataset.title}`;
    $('#announcement').textContent = `Slide ${current + 1} of ${slides.length}: ${slides[current].dataset.title}`;
    document.querySelectorAll('.overview-card').forEach((card, i) => card.setAttribute('aria-current', String(i === current)));
    updateNotes();
    if (updateHash) {
      // replaceState can be restricted for local files in some browsers.
      try { history.replaceState(null, '', `#${current + 1}`); }
      catch { if (location.hash !== `#${current + 1}`) location.hash = String(current + 1); }
    }
  }

  function indexFromHash() {
    const value = location.hash.replace(/^#(?:slide-)?/, '');
    return /^\d+$/.test(value) ? Number(value) - 1 : 0;
  }

  function openDialog(dialog, trigger) {
    lastDialogTrigger = trigger || document.activeElement;
    dialogs.forEach((item) => { if (item.open) item.close(); });
    dialog.showModal();
    if (dialog.id === 'overview-dialog') {
      const activeCard = dialog.querySelector('[aria-current="true"]');
      activeCard?.focus();
      activeCard?.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeDialogs() {
    dialogs.forEach((dialog) => { if (dialog.open) dialog.close(); });
  }

  function toggleNotes(force) {
    const open = force === undefined ? $('#notes-panel').hidden : force;
    $('#notes-panel').hidden = !open;
    document.body.classList.toggle('notes-open', open);
    $('#notes-button').setAttribute('aria-expanded', String(open));
    updateNotes();
    scheduleFit();
  }

  function selectScreen(key) {
    activeScreen = key;
    document.querySelectorAll('.showcase-tab').forEach(tab => {
      const selected = tab.dataset.screen === key;
      tab.classList.toggle('is-selected', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    });
  }

  document.querySelectorAll('.showcase-tab').forEach((tab, index, tabs) => {
    tab.addEventListener('click', () => selectScreen(tab.dataset.screen));
    tab.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      let target = index;
      if (['ArrowUp', 'ArrowLeft'].includes(event.key)) target = (index + tabs.length - 1) % tabs.length;
      if (['ArrowDown', 'ArrowRight'].includes(event.key)) target = (index + 1) % tabs.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = tabs.length - 1;
      selectScreen(tabs[target].dataset.screen);
      tabs[target].focus();
    });
  });

  document.querySelectorAll('[data-screenshot]').forEach(button => {
    button.addEventListener('click', () => {
      const original = button.querySelector('img');
      $('#screenshot-title').textContent = button.dataset.title;
      $('#screenshot-image').src = original.currentSrc || original.src;
      $('#screenshot-image').alt = original.alt;
      openDialog($('#screenshot-dialog'), button);
    });
  });

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.body.requestFullscreen) await document.body.requestFullscreen();
      else $('#announcement').textContent = 'Use your browser fullscreen control to present.';
    } catch {
      $('#announcement').textContent = 'Fullscreen is unavailable. Use your browser fullscreen control.';
    }
  }

  function toggleBlank(force) {
    $('#blank-screen').hidden = force === undefined ? !$('#blank-screen').hidden : !force;
  }

  function buildOverview() {
    const grid = $('#overview-grid');
    slides.forEach((slide, index) => {
      const card = document.createElement('button');
      card.className = 'overview-card';
      if (slide.classList.contains('theme-dark')) card.classList.add('dark');
      if (index === 0) card.classList.add('cover-thumbnail');
      card.setAttribute('aria-label', `Go to slide ${index + 1}: ${slide.dataset.title}`);
      const number = document.createElement('span');
      number.className = 'overview-number';
      number.textContent = `${String(index + 1).padStart(2, '0')}${index > 11 ? ' / APPENDIX' : ''}`;
      const title = document.createElement('span');
      title.className = 'overview-title';
      title.textContent = slide.dataset.title;
      card.append(number, title);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#mark');
      svg.setAttribute('aria-hidden', 'true');
      svg.append(use);
      card.append(svg);
      card.addEventListener('click', () => { showSlide(index); closeDialogs(); });
      card.addEventListener('keydown', (event) => {
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
        if (event.key in offsets) {
          event.preventDefault();
          event.stopPropagation();
          const target = Math.min(slides.length - 1, Math.max(0, index + offsets[event.key]));
          grid.children[target].focus();
        }
      });
      grid.append(card);
    });
  }

  function renderDemo() {
    const step = (channel === 'ussd' ? ussdSteps : smsSteps)[demoStep];
    $('#demo-ussd').hidden = channel !== 'ussd';
    $('#demo-sms').hidden = channel !== 'sms';
    document.querySelectorAll('.demo-tab').forEach((tab) => {
      const selected = tab.dataset.channel === channel;
      tab.classList.toggle('is-selected', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    $('#demo-description strong').textContent = step.title;
    $('#demo-description p').textContent = step.description;
    if (channel === 'ussd') {
      const content = $('#ussd-content');
      content.replaceChildren();
      step.lines.forEach((line, i) => {
        if (i) content.append(document.createElement('br'));
        content.append(document.createTextNode(line));
      });
      $('#ussd-input').replaceChildren(document.createTextNode(`${step.prompt} `));
      const input = document.createElement('span');
      input.textContent = step.input;
      $('#ussd-input').append(input);
    } else {
      const content = $('#sms-content');
      content.replaceChildren();
      for (const [direction, message] of [['outgoing', step.outgoing], ['incoming', step.incoming]]) {
        if (!message) continue;
        const bubble = document.createElement('div');
        bubble.className = `sms-bubble ${direction}`;
        const label = document.createElement('small');
        label.textContent = direction === 'outgoing' ? 'YOU' : 'HEALTHACCESS';
        bubble.append(label, document.createTextNode(message));
        content.append(bubble);
      }
      const label = document.createElement('span');
      label.className = 'sms-demo-label';
      label.textContent = 'Illustrative messages · Demo data';
      content.append(label);
    }
    document.querySelectorAll('.demo-pagination span').forEach((dot, i) => dot.classList.toggle('is-current', i === demoStep));
    $('#demo-next').firstChild.textContent = demoStep === 3 ? 'Replay the example ' : 'Try the next step ';
    $('#demo-next').setAttribute('aria-label', demoStep === 3 ? 'Replay the basic phone example' : `Show step ${demoStep + 2} of the ${channel.toUpperCase()} example`);
  }

  $('#previous').addEventListener('click', () => showSlide(current - 1));
  $('#next').addEventListener('click', () => showSlide(current + 1));
  $('#overview-button').addEventListener('click', (event) => openDialog($('#overview-dialog'), event.currentTarget));
  $('#slide-counter').addEventListener('click', (event) => openDialog($('#overview-dialog'), event.currentTarget));
  $('#help-button').addEventListener('click', (event) => openDialog($('#help-dialog'), event.currentTarget));
  $('#notes-button').addEventListener('click', () => toggleNotes());
  $('#close-notes').addEventListener('click', () => { toggleNotes(false); $('#notes-button').focus(); });
  $('#fullscreen-button').addEventListener('click', toggleFullscreen);
  $('#print-button').addEventListener('click', () => { closeDialogs(); window.print(); });
  $('#blank-screen').addEventListener('click', () => toggleBlank(false));
  $('#demo-next').addEventListener('click', () => { demoStep = (demoStep + 1) % 4; renderDemo(); });
  document.querySelectorAll('.demo-tab').forEach((tab) => {
    tab.addEventListener('click', () => { channel = tab.dataset.channel; demoStep = 0; renderDemo(); });
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        channel = channel === 'ussd' ? 'sms' : 'ussd';
        demoStep = 0;
        renderDemo();
        $(`#tab-${channel}`).focus();
      }
    });
  });

  dialogs.forEach((dialog) => {
    dialog.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => lastDialogTrigger?.focus?.());
  });

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    if (event.key === 'Escape') {
      closeDialogs();
      toggleBlank(false);
      toggleNotes(false);
      return;
    }
    if (dialogs.some((dialog) => dialog.open)) return;
    const key = event.key.toLowerCase();
    if (key === 'b') { event.preventDefault(); toggleBlank(); return; }
    if (!$('#blank-screen').hidden) return;
    const buttonFocused = event.target.closest('button, a, [role="tab"]');
    if (event.key === ' ' && buttonFocused) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); showSlide(current + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); showSlide(current - 1); }
    else if (event.key === 'Home') { event.preventDefault(); showSlide(0); }
    else if (event.key === 'End') { event.preventDefault(); showSlide(slides.length - 1); }
    else if (key === 'o') { event.preventDefault(); openDialog($('#overview-dialog')); }
    else if (key === 'n') { event.preventDefault(); toggleNotes(); }
    else if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
    else if (key === '?' || key === 'h') { event.preventDefault(); openDialog($('#help-dialog')); }
  });

  viewport.addEventListener('touchstart', (event) => {
    if (event.target.closest('button,a') || event.touches.length !== 1) return;
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  viewport.addEventListener('touchend', (event) => {
    if (!touchStart) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) showSlide(current + (dx < 0 ? 1 : -1));
  }, { passive: true });

  window.addEventListener('resize', scheduleFit);
  window.addEventListener('hashchange', () => showSlide(indexFromHash(), false));
  document.addEventListener('fullscreenchange', () => {
    $('#fullscreen-button').setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
    scheduleFit();
  });
  // Printing exposes all slides to assistive output and resets the demo to its opening state.
  let savedDemo;
  window.addEventListener('beforeprint', () => {
    savedDemo = { channel, demoStep, activeScreen };
    selectScreen('overview');
    channel = 'ussd'; demoStep = 0; renderDemo();
    slides.forEach((slide) => { slide.inert = false; slide.removeAttribute('aria-hidden'); });
  });
  window.addEventListener('afterprint', () => {
    if (savedDemo) { ({ channel, demoStep } = savedDemo); renderDemo(); selectScreen(savedDemo.activeScreen); }
    showSlide(current);
  });

  buildOverview();
  renderDemo();
  showSlide(indexFromHash(), false);
  fitStage();
  document.fonts.ready.then(scheduleFit);
})();
