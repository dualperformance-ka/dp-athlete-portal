(function () {
  var loadedFor = '';
  var photosByKey = {};
  var attached = new WeakSet();
  var slots = ['front', 'side', 'back', 'front_flexed', 'back_flexed'];

  function slug(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function athleteCode() {
    var fromUrl = new URLSearchParams(location.search).get('code');
    var saved = localStorage.getItem('dp_auth_code');
    var hero = document.querySelector('.hn');
    return slug(fromUrl || saved || (hero && hero.textContent) || 'athlete');
  }

  function activeWeek() {
    var label = document.querySelector('.wlabel, .nut-wlabel');
    var text = label && label.textContent ? label.textContent : '';
    var match = text.match(/week\s*(\d+)/i);
    if (match) return 'week' + match[1];

    var selected = document.querySelector('[data-week].active, [data-week].selected');
    if (selected && selected.getAttribute('data-week')) return 'week' + selected.getAttribute('data-week').match(/\d+/)[0];

    return 'week1';
  }

  function slotForCell(cell, index) {
    var label = (cell.textContent || '').toLowerCase();
    if (label.indexOf('front flex') !== -1) return 'front_flexed';
    if (label.indexOf('back flex') !== -1) return 'back_flexed';
    if (label.indexOf('side') !== -1) return 'side';
    if (label.indexOf('back') !== -1) return 'back';
    if (label.indexOf('front') !== -1) return 'front';
    return slots[index % slots.length] || 'front';
  }

  function key(week, slot) {
    return String(week || '').toLowerCase() + ':' + String(slot || '').toLowerCase();
  }

  function setCellState(cell, photo) {
    cell.classList.toggle('has-photo', Boolean(photo));
    cell.querySelectorAll('img,.photo-overlay').forEach(function (node) { node.remove(); });

    if (!photo) return;

    var image = document.createElement('img');
    image.loading = 'lazy';
    image.alt = photo.slot + ' progress photo';
    image.src = photo.secureUrl;
    cell.prepend(image);

    var overlay = document.createElement('div');
    overlay.className = 'photo-overlay';
    overlay.textContent = photo.week || '';
    cell.appendChild(overlay);
  }

  function renderCells() {
    var week = activeWeek();
    document.querySelectorAll('.photo-cell').forEach(function (cell, index) {
      var slot = cell.getAttribute('data-cloudinary-slot') || slotForCell(cell, index);
      cell.setAttribute('data-cloudinary-slot', slot);
      setCellState(cell, photosByKey[key(week, slot)]);
    });
  }

  async function loadPhotos() {
    var code = athleteCode();
    if (!code || loadedFor === code) {
      renderCells();
      return;
    }

    loadedFor = code;
    photosByKey = {};

    try {
      var response = await fetch('/api/progress-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', athleteCode: code }),
      });
      if (!response.ok) throw new Error('Unable to load progress photos');
      var data = await response.json();
      (data.photos || []).forEach(function (photo) {
        photosByKey[key(photo.week, photo.slot)] = photo;
      });
    } catch (error) {
      console.warn('[progress photos]', error.message || error);
    }

    renderCells();
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Unable to read file')); };
      reader.readAsDataURL(file);
    });
  }

  async function uploadFromCell(cell) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';

    input.addEventListener('change', async function () {
      var file = input.files && input.files[0];
      if (!file) return;

      var week = activeWeek();
      var slot = cell.getAttribute('data-cloudinary-slot') || 'front';
      cell.classList.add('uploading');

      try {
        var imageData = await readFile(file);
        var response = await fetch('/api/progress-photos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload',
            athleteCode: athleteCode(),
            week: week,
            slot: slot,
            imageData: imageData,
          }),
        });

        var data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        photosByKey[key(data.photo.week, data.photo.slot)] = data.photo;
        renderCells();
      } catch (error) {
        alert(error.message || 'Progress photo upload failed');
      } finally {
        cell.classList.remove('uploading');
      }
    });

    input.click();
  }

  function attachCells() {
    document.querySelectorAll('.photo-cell').forEach(function (cell, index) {
      if (attached.has(cell)) return;
      attached.add(cell);
      cell.setAttribute('data-cloudinary-slot', slotForCell(cell, index));
      cell.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        uploadFromCell(cell);
      }, true);
    });
  }

  function tick() {
    attachCells();
    loadPhotos();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
  else tick();

  document.addEventListener('click', function (event) {
    if (event.target.closest('.tab,.warr,.wtoday,.nut-arr')) setTimeout(tick, 120);
  });

  new MutationObserver(function () { tick(); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 3000);
})();
