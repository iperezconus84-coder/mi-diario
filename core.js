/* Mi Diario — núcleo: cifrado, bóveda, fusión, sincronización y utilidades.
   Todo el cifrado ocurre en el dispositivo. Nada sale sin cifrar. */
(function (root) {
  'use strict';

  const ITER = 600000;              // iteraciones PBKDF2 (SHA-256)
  const CHECK_VALUE = 'diario-ok';  // valor conocido para verificar la contraseña
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = () => (root.crypto || globalThis.crypto).subtle;
  const rand = (n) => (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(n));

  /* ---------- Base64 ---------- */
  function b64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  // Base64 de texto Unicode (para la API de GitHub)
  function b64text(text) { return b64(enc.encode(text)); }
  function textFromB64(str) { return dec.decode(unb64(str.replace(/\s/g, ''))); }

  /* ---------- Cifrado ---------- */
  async function deriveKey(password, saltB64, iter) {
    const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter || ITER, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function encryptJSON(key, obj) {
    const iv = rand(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decryptJSON(key, box) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(dec.decode(pt));
  }

  /* ---------- Bóveda ----------
     { format, v, salt, iter, check:{iv,ct}, entries: { 'AAAA-MM-DD': {iv,ct,u} | {u,del:true} } } */
  async function createVault(password) {
    const salt = b64(rand(16));
    const key = await deriveKey(password, salt, ITER);
    const vault = {
      format: 'diario-cifrado', v: 1, salt, iter: ITER,
      check: await encryptJSON(key, CHECK_VALUE),
      entries: {}
    };
    return { vault, key };
  }
  async function unlockVault(vault, password) {
    const key = await deriveKey(password, vault.salt, vault.iter);
    let ok = false;
    try { ok = (await decryptJSON(key, vault.check)) === CHECK_VALUE; } catch (e) { ok = false; }
    if (!ok) throw new Error('Contraseña incorrecta');
    return key;
  }
  async function decryptAll(vault, key) {
    const out = {};
    for (const [id, rec] of Object.entries(vault.entries || {})) {
      if (rec.del) continue;
      try { out[id] = await decryptJSON(key, rec); } catch (e) { /* entrada dañada: se omite */ }
    }
    return out;
  }
  async function putEntry(vault, key, entry, now) {
    const rec = await encryptJSON(key, entry);
    rec.u = now || Date.now();
    vault.entries[entry.id] = rec;
    return rec;
  }
  function deleteEntry(vault, id, now) {
    vault.entries[id] = { u: now || Date.now(), del: true };
  }
  function isValidVault(v) {
    return v && v.format === 'diario-cifrado' && typeof v.salt === 'string' &&
      v.check && v.check.iv && v.check.ct && typeof v.entries === 'object';
  }

  /* ---------- Fusión ----------
     Gana la versión editada más recientemente de cada día.
     Devuelve la bóveda fusionada, los días que cambiaron en local y si hay que subir cambios. */
  function mergeVaults(local, remote) {
    if (!remote) return { merged: local, changedIds: [], needsPush: true };
    if (remote.salt !== local.salt) {
      throw new Error('El diario remoto usa otra contraseña o es otro diario.');
    }
    const merged = Object.assign({}, local, { entries: {} });
    const changedIds = [];
    let needsPush = false;
    const ids = new Set([...Object.keys(local.entries || {}), ...Object.keys(remote.entries || {})]);
    for (const id of ids) {
      const l = local.entries[id];
      const r = remote.entries[id];
      if (l && !r) { merged.entries[id] = l; needsPush = true; }
      else if (!l && r) { merged.entries[id] = r; changedIds.push(id); }
      else if (l.u > r.u) { merged.entries[id] = l; needsPush = true; }
      else if (r.u > l.u) { merged.entries[id] = r; changedIds.push(id); }
      else { merged.entries[id] = l; }
    }
    return { merged, changedIds, needsPush };
  }

  /* ---------- Sincronización con un repositorio privado de GitHub ---------- */
  function ghHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  function ghUrl(cfg) {
    const path = (cfg.path || 'diario.json').split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
  }
  async function ghRead(cfg, token, fetchFn) {
    const f = fetchFn || fetch;
    const res = await f(ghUrl(cfg), { headers: ghHeaders(token), cache: 'no-store' });
    if (res.status === 404) {
      // ¿No existe el archivo o no existe el repositorio / sin permiso?
      const repoRes = await f(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`,
        { headers: ghHeaders(token), cache: 'no-store' });
      if (repoRes.status !== 200) throw new Error('No encuentro el repositorio o el token no tiene acceso a él.');
      return { vault: null, sha: null };
    }
    if (res.status === 401) throw new Error('El token no es válido o expiró.');
    if (res.status === 403) throw new Error('GitHub rechazó el acceso (revisa los permisos del token).');
    if (!res.ok) throw new Error('Error de GitHub (' + res.status + ').');
    const j = await res.json();
    let text;
    if (j.content && j.encoding === 'base64') {
      text = textFromB64(j.content);
    } else {
      // Archivos de más de 1 MB: leer el blob por su sha
      const br = await f(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/blobs/${j.sha}`,
        { headers: ghHeaders(token), cache: 'no-store' });
      if (!br.ok) throw new Error('No pude leer el diario remoto (' + br.status + ').');
      const bj = await br.json();
      text = textFromB64(bj.content);
    }
    const vault = JSON.parse(text);
    if (!isValidVault(vault)) throw new Error('El archivo remoto no es un diario válido.');
    return { vault, sha: j.sha };
  }
  async function ghWrite(cfg, token, vault, sha, fetchFn) {
    const f = fetchFn || fetch;
    const body = {
      message: 'Diario: actualización cifrada ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
      content: b64text(JSON.stringify(vault))
    };
    if (sha) body.sha = sha;
    const res = await f(ghUrl(cfg), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(token)),
      body: JSON.stringify(body)
    });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (res.status === 401) throw new Error('El token no es válido o expiró.');
    if (res.status === 403 || res.status === 404) throw new Error('El token no tiene permiso de escritura en el repositorio.');
    if (!res.ok) throw new Error('Error al guardar en GitHub (' + res.status + ').');
    const j = await res.json();
    return { sha: j.content && j.content.sha };
  }
  /* Sincroniza en ambos sentidos. Devuelve { vault, changedIds }. */
  async function syncVault(local, cfg, token, fetchFn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { vault: remote, sha } = await ghRead(cfg, token, fetchFn);
      const { merged, changedIds, needsPush } = mergeVaults(local, remote);
      if (!needsPush) return { vault: merged, changedIds };
      const w = await ghWrite(cfg, token, merged, sha, fetchFn);
      if (!w.conflict) return { vault: merged, changedIds };
      local = merged; // otro dispositivo guardó al mismo tiempo: reintentar
    }
    throw new Error('No pude sincronizar por cambios simultáneos. Intenta de nuevo.');
  }

  /* ---------- Fechas ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function dayId(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDayId(id) { const [y, m, d] = id.split('-').map(Number); return new Date(y, m - 1, d); }
  function dayOfYear(d) { return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); }

  /* ---------- Preguntas guía ---------- */
  const PROMPTS = [
    '¿Qué fue lo mejor de hoy y por qué?',
    '¿Qué fue lo más difícil de hoy y cómo lo enfrenté?',
    '¿A quién quiero agradecerle algo hoy?',
    '¿Dónde vi la presencia de Dios hoy?',
    '¿Qué conversación me quedó dando vueltas?',
    '¿Qué me está preocupando? ¿Qué parte depende de mí?',
    '¿Qué haría distinto si pudiera repetir el día?',
    '¿Qué aprendí hoy, aunque sea pequeño?',
    '¿Qué recuerdo de mi juventud me vino a la mente?',
    '¿En qué momento del día me sentí más en paz?',
    '¿Qué me dio energía hoy y qué me la quitó?',
    '¿Qué sueño o meta tengo un poco olvidada?',
    '¿Qué le diría a la persona que fui hace diez años?',
    '¿A quién extraño y qué le diría si estuviera aquí?',
    '¿Qué gesto de alguien me conmovió hoy?',
    '¿Qué decisión estoy postergando y por qué?',
    '¿Qué me hizo reír hoy?',
    '¿Qué quiero pedirle a Dios para mañana?',
    '¿Qué parte de mi trabajo me hizo sentir útil?',
    '¿Cómo estuve presente para mi familia hoy?',
    '¿Qué me gustaría que recordaran de mí?',
    '¿Qué estoy aprendiendo de los jóvenes con los que trabajo?',
    '¿Qué hábito quiero cuidar esta semana?',
    '¿Qué lugar me hizo sentir en casa?',
    '¿Qué pensamiento se repitió hoy en mi cabeza?',
    '¿Qué perdón necesito dar o pedir?',
    '¿Qué texto, canción o frase me acompañó hoy?',
    '¿De qué me siento orgullosa/o esta semana?',
    '¿Qué necesito soltar?',
    '¿Cómo cuidé mi cuerpo y mi descanso hoy?',
    '¿Qué pequeño detalle del día no quiero olvidar?',
    '¿Qué me pide este momento de mi vida?',
    '¿Con quién me gustaría reencontrarme?',
    '¿Qué miedo apareció hoy y qué hay detrás de él?',
    'Si hoy fuera una foto, ¿qué mostraría?',
    '¿Qué promesa me hice y cómo voy con ella?',
    '¿Qué quiero agradecer de este año hasta ahora?',
    '¿Qué servicio o ayuda di o recibí hoy?',
    '¿Qué me sorprendió de mí hoy?',
    'Mañana quiero…'
  ];
  function promptFor(date, offset) {
    const i = (dayOfYear(date) + date.getFullYear() * 7 + (offset || 0)) % PROMPTS.length;
    return PROMPTS[(i + PROMPTS.length) % PROMPTS.length];
  }

  /* ---------- Recordatorio (.ics) ---------- */
  function reminderICS(time, url, startDate) {
    const [hh, mm] = (time || '21:30').split(':');
    const d = startDate || new Date();
    const ymd = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mi Diario//ES', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:recordatorio-mi-diario-' + ymd + '@mi-diario',
      'DTSTAMP:' + stamp,
      'DTSTART:' + ymd + 'T' + pad(hh) + pad(mm) + '00',
      'DURATION:PT10M',
      'RRULE:FREQ=DAILY',
      'SUMMARY:✍️ Escribir mi diario',
      'DESCRIPTION:Unos minutos para ti. ' + (url || ''),
      url ? 'URL:' + url : '',
      'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Hora de escribir tu diario', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'
    ].filter(Boolean).join('\r\n') + '\r\n';
  }

  /* ---------- Exportar como texto ---------- */
  const MOODS = { 5: '😄 Muy bien', 4: '🙂 Bien', 3: '😐 Normal', 2: '😔 Difícil', 1: '😣 Muy difícil' };
  function entriesToText(entries) {
    return Object.keys(entries).sort().map((id) => {
      const e = entries[id];
      const lines = ['=== ' + id + (e.mood ? '  ·  ' + MOODS[e.mood] : '') + ' ==='];
      if (e.prompt) lines.push('Pregunta: ' + e.prompt);
      if (e.text) lines.push('', e.text.trim());
      const g = (e.gratitude || []).filter(Boolean);
      if (g.length) lines.push('', 'Agradezco:', ...g.map((x) => '• ' + x));
      return lines.join('\n');
    }).join('\n\n') + '\n';
  }

  /* ---------- Estadísticas ---------- */
  function streak(entries, today) {
    let n = 0;
    const d = new Date(today);
    if (!entries[dayId(d)]) d.setDate(d.getDate() - 1); // si hoy aún no escribe, cuenta desde ayer
    while (entries[dayId(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  root.DiarioCore = {
    ITER, b64, unb64, b64text, textFromB64,
    deriveKey, encryptJSON, decryptJSON,
    createVault, unlockVault, decryptAll, putEntry, deleteEntry, isValidVault,
    mergeVaults, ghRead, ghWrite, syncVault,
    pad, dayId, parseDayId, PROMPTS, promptFor, reminderICS, MOODS, entriesToText, streak
  };
})(typeof window !== 'undefined' ? window : globalThis);
