/* Mi Diario — interfaz */
(function () {
  'use strict';
  const C = window.DiarioCore;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const LS_VAULT = 'miDiario.vault.v1';
  const LS_SET = 'miDiario.settings.v1';
  const MOOD_EMOJI = { 1: '😣', 2: '😔', 3: '😐', 4: '🙂', 5: '😄' };

  let vault = null;        // bóveda cifrada (se guarda en el dispositivo)
  let key = null;          // llave en memoria, solo mientras está desbloqueado
  let entries = {};        // entradas descifradas en memoria
  let settings = loadSettings();
  let current = C.dayId(new Date());
  let promptOffset = 0;
  let monthCursor = new Date();
  let saveTimer = null, syncTimer = null, savePromise = null;
  let syncing = false, syncAgain = false;
  let lastActivity = Date.now(), hiddenAt = null;

  /* ---------- Almacenamiento local ---------- */
  function loadVault() {
    try { const v = JSON.parse(localStorage.getItem(LS_VAULT)); return C.isValidVault(v) ? v : null; }
    catch (e) { return null; }
  }
  function persist() {
    try { localStorage.setItem(LS_VAULT, JSON.stringify(vault)); }
    catch (e) { toast('No pude guardar en este dispositivo (¿sin espacio?).'); }
  }
  function loadSettings() {
    const def = { owner: '', repo: '', path: 'diario.json', tokenBox: null, lastSync: 0, autolock: 5, reminder: '21:30', notionUrl: '' };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(LS_SET)) || {}); } catch (e) { return def; }
  }
  function saveSettings() { try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch (e) {} }
  const syncConfigured = () => !!(settings.owner && settings.repo && settings.tokenBox);

  /* ---------- Utilidades ---------- */
  function show(id) {
    ['#screen-setup', '#screen-lock', '#screen-app'].forEach((s) => { $(s).hidden = s !== id; });
  }
  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtLong(id) {
    const s = C.parseDayId(id).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function fmtShort(id) { return C.parseDayId(id).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' }); }
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches'; }
  async function busy(btn, fn) { if (btn) btn.disabled = true; try { return await fn(); } finally { if (btn) btn.disabled = false; } }

  /* ---------- Inicio ---------- */
  function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    vault = loadVault();
    if (vault) showLock(); else show('#screen-setup');
  }
  function showLock() {
    $('#lock-greeting').textContent = greeting() + '. Escribe tu contraseña para abrir tu diario.';
    $('#unlock-pass').value = ''; $('#unlock-error').textContent = '';
    show('#screen-lock');
    setTimeout(() => $('#unlock-pass').focus(), 50);
  }
  async function enterApp() {
    show('#screen-app');
    switchView('write');
    loadDay(C.dayId(new Date()));
    lastActivity = Date.now();
    updateSyncBadge();
    if (syncConfigured()) syncNow(true);
  }

  /* --- Crear / unirse / restaurar --- */
  $$('[data-setup]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-setup]').forEach((x) => x.classList.toggle('active', x === b));
    $('#form-new').hidden = b.dataset.setup !== 'new';
    $('#form-join').hidden = b.dataset.setup !== 'join';
    $('#setup-error').textContent = '';
  }));

  $('#form-new').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const p1 = $('#new-pass').value, p2 = $('#new-pass2').value;
    if (p1.length < 8) { $('#setup-error').textContent = 'La contraseña debe tener al menos 8 caracteres.'; return; }
    if (p1 !== p2) { $('#setup-error').textContent = 'Las contraseñas no coinciden.'; return; }
    busy(ev.submitter, async () => {
      const r = await C.createVault(p1);
      vault = r.vault; key = r.key; entries = {};
      persist();
      $('#new-pass').value = $('#new-pass2').value = '';
      await enterApp();
      toast('¡Tu diario está listo! Escribe tu primera entrada.');
    });
  });

  $('#form-join').addEventListener('submit', (ev) => {
    ev.preventDefault();
    $('#setup-error').textContent = '';
    const cfg = { owner: $('#join-owner').value.trim(), repo: $('#join-repo').value.trim(), path: 'diario.json' };
    const token = $('#join-token').value.trim();
    const pass = $('#join-pass').value;
    busy(ev.submitter, async () => {
      try {
        const { vault: remote } = await C.ghRead(cfg, token);
        if (!remote) throw new Error('Aún no hay un diario en ese repositorio. Créalo primero en tu otro dispositivo y activa allí la sincronización.');
        key = await C.unlockVault(remote, pass);
        vault = remote; persist();
        entries = await C.decryptAll(vault, key);
        Object.assign(settings, cfg, { tokenBox: await C.encryptJSON(key, token), lastSync: Date.now() });
        saveSettings();
        $('#join-token').value = $('#join-pass').value = '';
        await enterApp();
        toast('Diario sincronizado en este dispositivo.');
      } catch (e) { $('#setup-error').textContent = e.message; }
    });
  });

  $('#setup-import').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    try {
      const v = JSON.parse(await f.text());
      if (!C.isValidVault(v)) throw new Error();
      vault = v; persist(); showLock();
      toast('Respaldo cargado. Ábrelo con la contraseña de ese diario.');
    } catch (e) { $('#setup-error').textContent = 'Ese archivo no es un respaldo válido de Mi Diario.'; }
  });

  /* --- Desbloquear / bloquear --- */
  $('#form-unlock').addEventListener('submit', (ev) => {
    ev.preventDefault();
    $('#unlock-error').textContent = '';
    busy(ev.submitter, async () => {
      try {
        key = await C.unlockVault(vault, $('#unlock-pass').value);
        entries = await C.decryptAll(vault, key);
        $('#unlock-pass').value = '';
        await enterApp();
      } catch (e) {
        $('#unlock-error').textContent = 'Contraseña incorrecta.';
        $('#unlock-pass').select();
      }
    });
  });

  async function lock() {
    if (!key) return;
    await flushSave();
    key = null; entries = {};
    $('#entry-text').value = ''; $$('.grat').forEach((i) => { i.value = ''; });
    $('#entry-list').textContent = ''; $('#grat-list').textContent = ''; $('#on-this-day').hidden = true;
    showLock();
  }
  $('#btn-lock').addEventListener('click', lock);

  ['pointerdown', 'keydown', 'input', 'scroll', 'touchstart'].forEach((t) =>
    document.addEventListener(t, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
  setInterval(() => {
    if (key && Date.now() - lastActivity > settings.autolock * 60000) lock();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); flushSave(); }
    else if (key && hiddenAt && Date.now() - hiddenAt > settings.autolock * 60000) lock();
    else if (key && syncConfigured()) syncNow(true);
  });

  /* ---------- Navegación ---------- */
  function switchView(name) {
    $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'calendar') renderCalendar();
    if (name === 'mood') renderMood();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  $$('.tabbar button').forEach((b) => b.addEventListener('click', async () => {
    await flushSave(); switchView(b.dataset.view);
  }));

  /* ---------- Escribir ---------- */
  let currentPrompt = '';
  function loadDay(id) {
    current = id; promptOffset = 0;
    const e = entries[id];
    const date = C.parseDayId(id);
    const isToday = id === C.dayId(new Date());
    $('#day-title').textContent = (isToday ? 'Hoy · ' : '') + fmtLong(id);
    $('#day-input').value = id;
    currentPrompt = (e && e.prompt) || C.promptFor(date, 0);
    $('#prompt-text').textContent = currentPrompt;
    setMood(e ? e.mood : 0);
    $('#entry-text').value = e ? e.text || '' : '';
    $$('.grat').forEach((inp) => { inp.value = (e && e.gratitude && e.gratitude[+inp.dataset.i]) || ''; });
    $('#entry-delete').hidden = !e;
    $('#save-status').textContent = e ? 'Guardado · cifrado 🔐' : '';
    renderOnThisDay(id);
  }
  function setMood(m) { $$('.mood-options button').forEach((b) => b.classList.toggle('sel', +b.dataset.mood === m)); }
  function currentMood() { const s = $('.mood-options button.sel'); return s ? +s.dataset.mood : 0; }

  function collect() {
    return {
      id: current,
      prompt: currentPrompt,
      mood: currentMood(),
      text: $('#entry-text').value,
      gratitude: $$('.grat').map((i) => i.value.trim()),
      updated: new Date().toISOString()
    };
  }
  function isEmpty(e) { return !e.text.trim() && !e.mood && !e.gratitude.some(Boolean); }

  function scheduleSave() {
    $('#save-status').textContent = 'Escribiendo…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 700);
  }
  async function doSave() {
    saveTimer = null;
    if (!key) return;
    const e = collect();
    if (isEmpty(e) && !entries[e.id]) { $('#save-status').textContent = ''; return; }
    savePromise = (async () => {
      entries[e.id] = e;
      await C.putEntry(vault, key, e);
      persist();
      if (e.id === current) {
        $('#save-status').textContent = 'Guardado · cifrado 🔐';
        $('#entry-delete').hidden = false;
      }
      scheduleSync();
    })();
    await savePromise; savePromise = null;
  }
  async function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); await doSave(); }
    else if (savePromise) await savePromise;
  }

  $('#entry-text').addEventListener('input', scheduleSave);
  $$('.grat').forEach((i) => i.addEventListener('input', scheduleSave));
  $$('.mood-options button').forEach((b) => b.addEventListener('click', () => {
    setMood(currentMood() === +b.dataset.mood ? 0 : +b.dataset.mood); scheduleSave();
  }));
  $('#prompt-other').addEventListener('click', () => {
    promptOffset++;
    currentPrompt = C.promptFor(C.parseDayId(current), promptOffset);
    $('#prompt-text').textContent = currentPrompt;
    if (entries[current]) scheduleSave();
  });
  async function goDay(delta) {
    await flushSave();
    const d = C.parseDayId(current); d.setDate(d.getDate() + delta); loadDay(C.dayId(d));
  }
  $('#day-prev').addEventListener('click', () => goDay(-1));
  $('#day-next').addEventListener('click', () => goDay(1));
  $('#day-input').addEventListener('change', async (ev) => { if (ev.target.value) { await flushSave(); loadDay(ev.target.value); } });
  $('#entry-delete').addEventListener('click', async () => {
    if (!confirm('¿Borrar la entrada de ' + fmtLong(current) + '? No se puede deshacer.')) return;
    clearTimeout(saveTimer); saveTimer = null;
    C.deleteEntry(vault, current); delete entries[current];
    persist(); loadDay(current); scheduleSync(); toast('Entrada borrada.');
  });

  function renderOnThisDay(id) {
    const box = $('#on-this-day'); box.textContent = '';
    const md = id.slice(5);
    const past = Object.keys(entries).filter((k) => k.slice(5) === md && k < id).sort().reverse();
    if (!past.length) { box.hidden = true; return; }
    const k = past[0];
    const years = +id.slice(0, 4) - +k.slice(0, 4);
    box.appendChild(el('div', 'when', 'Un día como hoy, hace ' + years + (years === 1 ? ' año' : ' años')));
    box.appendChild(el('p', null, (entries[k].text || '').slice(0, 280) + ((entries[k].text || '').length > 280 ? '…' : '')));
    const b = el('button', 'link-btn', 'Leer completa →');
    b.addEventListener('click', () => loadDay(k));
    box.appendChild(b);
    box.hidden = false;
  }

  /* ---------- Calendario y búsqueda ---------- */
  function renderCalendar() {
    const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
    const t = new Date(y, m, 1).toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
    $('#month-title').textContent = t.charAt(0).toUpperCase() + t.slice(1);
    const grid = $('#cal-grid'); grid.textContent = '';
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // lunes primero
    const days = new Date(y, m + 1, 0).getDate();
    const today = C.dayId(new Date());
    for (let i = 0; i < offset; i++) grid.appendChild(el('div', 'cal-day empty'));
    for (let d = 1; d <= days; d++) {
      const id = C.dayId(new Date(y, m, d));
      const e = entries[id];
      const b = el('button', 'cal-day' + (e ? ' has' : '') + (id === today ? ' today' : ''));
      b.appendChild(el('span', null, String(d)));
      if (e) b.appendChild(el('span', 'dot', e.mood ? MOOD_EMOJI[e.mood] : '•'));
      b.setAttribute('aria-label', fmtLong(id) + (e ? ', con entrada' : ''));
      b.addEventListener('click', () => { switchView('write'); loadDay(id); });
      grid.appendChild(b);
    }
    renderList();
  }
  function renderList() {
    const q = norm($('#search').value.trim());
    const list = $('#entry-list'); list.textContent = '';
    let ids;
    if (q) {
      ids = Object.keys(entries).filter((id) => {
        const e = entries[id];
        return norm([e.text, e.prompt, ...(e.gratitude || [])].join(' ')).includes(q);
      });
    } else {
      const pre = monthCursor.getFullYear() + '-' + C.pad(monthCursor.getMonth() + 1);
      ids = Object.keys(entries).filter((id) => id.startsWith(pre));
    }
    ids.sort().reverse();
    if (!ids.length) { list.appendChild(el('p', 'muted small', q ? 'Sin resultados.' : 'No hay entradas este mes.')); return; }
    ids.forEach((id) => {
      const e = entries[id];
      const b = el('button', 'entry-item');
      b.appendChild(el('div', 'when', (e.mood ? MOOD_EMOJI[e.mood] + ' ' : '') + fmtShort(id)));
      b.appendChild(el('p', null, (e.text || '').trim() || (e.gratitude || []).filter(Boolean).join(' · ') || '(sin texto)'));
      b.addEventListener('click', () => { switchView('write'); loadDay(id); });
      list.appendChild(b);
    });
  }
  $('#month-prev').addEventListener('click', () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1); renderCalendar(); });
  $('#month-next').addEventListener('click', () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1); renderCalendar(); });
  $('#search').addEventListener('input', renderList);

  /* ---------- Ánimo ---------- */
  function renderMood() {
    const now = new Date();
    $('#st-streak').textContent = C.streak(entries, now);
    $('#st-total').textContent = Object.keys(entries).length;
    const days = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(C.dayId(d)); }
    const moods = days.map((id) => (entries[id] && entries[id].mood) || 0);
    const rated = moods.filter(Boolean);
    $('#st-avg').textContent = rated.length ? MOOD_EMOJI[Math.round(rated.reduce((a, b) => a + b, 0) / rated.length)] : '–';

    const W = 330, H = 150, pad = 18, bw = (W - pad) / 30;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Ánimo de los últimos 30 días');
    [1, 3, 5].forEach((lvl) => {
      const y = H - (lvl / 5) * (H - 10);
      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', pad); ln.setAttribute('x2', W); ln.setAttribute('y1', y); ln.setAttribute('y2', y);
      ln.setAttribute('stroke', 'var(--line)'); ln.setAttribute('stroke-dasharray', '2 3');
      svg.appendChild(ln);
      const tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', 0); tx.setAttribute('y', y + 4); tx.setAttribute('font-size', '10');
      tx.textContent = MOOD_EMOJI[lvl]; svg.appendChild(tx);
    });
    moods.forEach((m, i) => {
      const x = pad + i * bw + 1.5, w = bw - 3;
      const r = document.createElementNS(ns, 'rect');
      const h = m ? (m / 5) * (H - 10) : 3;
      r.setAttribute('x', x); r.setAttribute('width', w); r.setAttribute('y', H - h); r.setAttribute('height', h);
      r.setAttribute('rx', 2.5); r.setAttribute('fill', m ? `var(--m${m})` : 'var(--line)');
      const title = document.createElementNS(ns, 'title');
      title.textContent = fmtShort(days[i]) + (m ? ' · ' + C.MOODS[m] : ' · sin registro');
      r.appendChild(title); svg.appendChild(r);
    });
    [[0, 'start'], [29, 'end']].forEach(([i, anchor]) => {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', anchor === 'start' ? pad : W); t.setAttribute('y', H + 16);
      t.setAttribute('font-size', '10'); t.setAttribute('fill', 'var(--muted)'); t.setAttribute('text-anchor', anchor);
      t.textContent = C.parseDayId(days[i]).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
      svg.appendChild(t);
    });
    const chart = $('#mood-chart'); chart.textContent = ''; chart.appendChild(svg);

    const list = $('#grat-list'); list.textContent = '';
    const items = [];
    Object.keys(entries).sort().reverse().forEach((id) => {
      (entries[id].gratitude || []).filter(Boolean).forEach((g) => items.push([id, g]));
    });
    if (!items.length) list.appendChild(el('li', 'muted', 'Aún no hay agradecimientos. Anótalos al escribir cada día.'));
    items.slice(0, 12).forEach(([id, g]) => {
      const li = el('li'); li.appendChild(el('span', null, fmtShort(id))); li.appendChild(document.createTextNode(g)); list.appendChild(li);
    });
  }

  /* ---------- Sincronización ---------- */
  function updateSyncBadge(state) {
    const b = $('#sync-status');
    if (!syncConfigured()) { b.textContent = ''; return; }
    b.textContent = state === 'busy' ? '☁️ …' : state === 'error' ? '☁️ ⚠️' : '☁️ ✓';
  }
  function scheduleSync() {
    if (!syncConfigured()) return;
    clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(true), 4000);
  }
  async function syncNow(silent) {
    if (!key || !syncConfigured()) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true; updateSyncBadge('busy');
    const before = vault;
    try {
      const token = await C.decryptJSON(key, settings.tokenBox);
      const cfg = { owner: settings.owner, repo: settings.repo, path: settings.path || 'diario.json' };
      const res = await C.syncVault(vault, cfg, token);
      const nv = res.vault;
      // Cambios hechos mientras se sincronizaba
      for (const [id, rec] of Object.entries(before.entries)) {
        if (!nv.entries[id] || rec.u > nv.entries[id].u) { nv.entries[id] = rec; syncAgain = true; }
      }
      vault = nv; persist();
      for (const id of res.changedIds) {
        const rec = vault.entries[id];
        if (rec.del) delete entries[id];
        else { try { entries[id] = await C.decryptJSON(key, rec); } catch (e) {} }
      }
      settings.lastSync = Date.now(); saveSettings();
      updateSyncBadge('ok');
      if (res.changedIds.length) {
        if (res.changedIds.includes(current) && !saveTimer && document.activeElement !== $('#entry-text')) loadDay(current);
        if (!$('#view-calendar').hidden) renderCalendar();
        if (!$('#view-mood').hidden) renderMood();
      }
      if (!silent) toast('Sincronizado ✓');
      if (!$('#view-settings').hidden) renderSettings();
    } catch (e) {
      updateSyncBadge('error');
      if (!silent) toast(e.message, 5000);
      $('#sync-info').textContent = 'Último error: ' + e.message;
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
  }

  /* ---------- Ajustes ---------- */
  function renderSettings() {
    $('#set-owner').value = settings.owner || '';
    $('#set-repo').value = settings.repo || '';
    $('#set-token').value = '';
    $('#set-token').placeholder = settings.tokenBox ? 'Guardado 🔐 (déjalo vacío para mantenerlo)' : 'github_pat_…';
    $('#autolock').value = String(settings.autolock);
    $('#reminder-time').value = settings.reminder || '21:30';
    $('#notion-url').value = settings.notionUrl || '';
    $('#sync-info').textContent = syncConfigured()
      ? (settings.lastSync ? 'Última sincronización: ' + new Date(settings.lastSync).toLocaleString('es-CL') : 'Aún sin sincronizar.')
      : 'Sin configurar: el diario solo vive en este dispositivo.';
  }
  $('#btn-sync-save').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    const owner = $('#set-owner').value.trim(), repo = $('#set-repo').value.trim(), token = $('#set-token').value.trim();
    if (!owner || !repo) { toast('Completa usuario y repositorio.'); return; }
    if (!token && !settings.tokenBox) { toast('Falta el token de acceso.'); return; }
    settings.owner = owner; settings.repo = repo; settings.path = settings.path || 'diario.json';
    if (token) settings.tokenBox = await C.encryptJSON(key, token);
    saveSettings();
    await syncNow(false);
  }));
  $('#btn-sync-now').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
    if (!syncConfigured()) { toast('Primero configura la sincronización.'); return; }
    await flushSave(); await syncNow(false);
  }));
  $('#notion-url').addEventListener('change', (ev) => { settings.notionUrl = ev.target.value.trim(); saveSettings(); });

  /* ---------- Enviar a Ideas de Notion ---------- */
  let lastSel = { start: 0, end: 0 };
  const ta = $('#entry-text');
  const rememberSel = () => { lastSel = { start: ta.selectionStart, end: ta.selectionEnd }; };
  ['select', 'keyup', 'mouseup', 'touchend', 'blur'].forEach((t) => ta.addEventListener(t, rememberSel));
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) rememberSel(); });
  ta.addEventListener('input', () => { lastSel = { start: 0, end: 0 }; });

  function ideaPayload() {
    const full = ta.value;
    const sel = lastSel.end > lastSel.start ? full.slice(lastSel.start, lastSel.end).trim() : '';
    const body = sel || full.trim();
    if (!body) return null;
    const firstLine = body.split('\n').find((l) => l.trim()) || body;
    const title = firstLine.length > 70 ? firstLine.slice(0, 67).trim() + '…' : firstLine.trim();
    const text = body + '\n\n— Desde mi diario, ' + fmtLong(current);
    return { title, text };
  }
  $('#btn-to-notion').addEventListener('click', async () => {
    const p = ideaPayload();
    if (!p) { toast('Escribe o selecciona algo primero.'); return; }
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
    if (isMobile && navigator.share) {
      try { await navigator.share({ title: p.title, text: p.text }); return; }
      catch (e) { if (e.name === 'AbortError') return; /* si falla, se usa el plan B */ }
    }
    let copied = false;
    try { await navigator.clipboard.writeText(p.text); copied = true; } catch (e) {}
    if (settings.notionUrl) window.open(settings.notionUrl, '_blank', 'noopener');
    if (copied) toast(settings.notionUrl ? 'Copiado ✓ Pégalo como nueva idea en Notion.' : 'Copiado ✓ Agrega el enlace de tu base en Ajustes para abrirla directo.', 4500);
    else toast('No pude copiar el texto. Selecciónalo y cópialo a mano.', 4500);
  });

  $('#autolock').addEventListener('change', (ev) => { settings.autolock = +ev.target.value; saveSettings(); });
  $('#btn-reminder').addEventListener('click', () => {
    settings.reminder = $('#reminder-time').value || '21:30'; saveSettings();
    const url = location.href.split('#')[0];
    download('recordatorio-diario.ics', C.reminderICS(settings.reminder, url), 'text/calendar');
    toast('Abre el archivo descargado para agregarlo a tu calendario.');
  });
  $('#btn-export-enc').addEventListener('click', async () => {
    await flushSave();
    download('mi-diario-respaldo-' + C.dayId(new Date()) + '.json', JSON.stringify(vault), 'application/json');
  });
  $('#import-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    try {
      const other = JSON.parse(await f.text());
      if (!C.isValidVault(other)) throw new Error('Ese archivo no es un respaldo válido de Mi Diario.');
      const { merged, changedIds } = C.mergeVaults(vault, other);
      vault = merged; persist();
      for (const id of changedIds) {
        const rec = vault.entries[id];
        if (rec.del) delete entries[id]; else entries[id] = await C.decryptJSON(key, rec);
      }
      scheduleSync();
      toast('Respaldo restaurado: ' + changedIds.length + ' entradas recuperadas.');
    } catch (e) { toast(e.message.includes('otra contraseña') ? 'Ese respaldo es de otro diario o tiene otra contraseña.' : e.message, 5000); }
  });
  $('#btn-export-txt').addEventListener('click', async () => {
    if (!confirm('El archivo de texto quedará SIN cifrar y cualquiera que lo abra podrá leerlo. ¿Continuar?')) return;
    await flushSave();
    download('mi-diario-' + C.dayId(new Date()) + '.txt', C.entriesToText(entries), 'text/plain;charset=utf-8');
  });
  $('#btn-wipe').addEventListener('click', () => {
    const msg = syncConfigured()
      ? '¿Quitar el diario de este dispositivo? Seguirá guardado (cifrado) en GitHub.'
      : 'No tienes sincronización: si lo quitas sin un respaldo, perderás tu diario para siempre. ¿Continuar?';
    if (!confirm(msg)) return;
    localStorage.removeItem(LS_VAULT); localStorage.removeItem(LS_SET);
    location.reload();
  });

  boot();
})();
