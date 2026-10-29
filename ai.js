/* Mi Diario — preguntas de seguimiento con IA que corre en el celular (WebLLM).
   El modelo se descarga una sola vez y queda guardado en el navegador.
   Lo que escribes nunca sale del dispositivo. */
(function (root) {
  'use strict';
  const LIB = 'https://esm.run/@mlc-ai/web-llm@0.2.86';

  const MODELS = {
    ligero: { name: 'Ligero', size: 'unos 300 MB', f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC' },
    recomendado: { name: 'Recomendado', size: 'cerca de 1 GB', f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' }
  };

  // Frases que indican riesgo. Ante ellas no se usa la IA: se muestra un mensaje fijo con ayuda real.
  const RISK = /(suicid|quitarme la vida|matarme|me quiero morir|quiero morir(me)?|ganas de morir|no quiero (seguir )?vivir|hacerme da[ñn]o|autolesi|cortarme|acabar con todo|desaparecer para siempre)/i;
  const RISK_REPLY = 'Lo que escribiste me importa. Si estás pensando en hacerte daño, no lo cargues solo: puedes llamar gratis al *4141, la línea de prevención del suicidio, o al 131 si es una emergencia. Hablar con alguien de confianza hoy también ayuda.';

  const SYSTEM = [
    'Eres el diario personal de una persona adulta en Chile. Tu único rol es ayudarle a reflexionar.',
    'Lee lo que escribió y responde con UNA sola pregunta breve y abierta (máximo 25 palabras) que le ayude a profundizar en lo que siente o piensa.',
    'Habla de "tú", con calidez y sencillez, en español. Responde solo en español.',
    'No des consejos, no diagnostiques, no juzgues, no resumas ni repitas lo que escribió, no agregues saludos ni explicaciones.',
    'Escribe únicamente la pregunta.'
  ].join(' ');

  let engine = null, loading = null, loadedId = null;

  async function support() {
    if (!navigator.gpu) return { ok: false, why: 'Este navegador no tiene WebGPU. Usa Chrome actualizado en Android o en el computador.' };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false, why: 'Tu dispositivo no ofrece aceleración gráfica para la IA.' };
      return { ok: true, f16: adapter.features.has('shader-f16') };
    } catch (e) {
      return { ok: false, why: 'No pude acceder a la aceleración gráfica de este dispositivo.' };
    }
  }

  async function load(modelKey, onProgress) {
    const m = MODELS[modelKey] || MODELS.recomendado;
    const s = await support();
    if (!s.ok) throw new Error(s.why);
    const id = s.f16 ? m.f16 : m.f32;
    if (engine && loadedId === id) return engine;
    if (loading) return loading;
    loading = (async () => {
      const lib = await import(LIB);
      const report = (r) => { if (onProgress) onProgress(Math.round((r.progress || 0) * 100), r.text || ''); };
      if (engine) { await engine.reload(id); }
      else {
        const worker = new Worker(new URL('ai-worker.js', document.baseURI), { type: 'module' });
        engine = await lib.CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: report });
      }
      loadedId = id;
      return engine;
    })();
    try { return await loading; }
    catch (e) { engine = null; loadedId = null; throw new Error('No pude preparar la IA: ' + (e.message || e)); }
    finally { loading = null; }
  }

  async function isDownloaded(modelKey) {
    try {
      const m = MODELS[modelKey] || MODELS.recomendado;
      const s = await support();
      if (!s.ok) return false;
      const lib = await import(LIB);
      return await lib.hasModelInCache(s.f16 ? m.f16 : m.f32);
    } catch (e) { return false; }
  }

  function clean(text) {
    let t = (text || '').replace(/\s+/g, ' ').trim().replace(/^["“«]|["”»]$/g, '');
    if (/[぀-ヿ㐀-鿿가-힯]/.test(t)) return '';   // salió en otro idioma
    const q = t.lastIndexOf('?');
    if (q > 0) t = t.slice(0, q + 1);
    const open = t.lastIndexOf('¿'), prevQ = open > 0 ? t.lastIndexOf('?', open) : -1;
    if (prevQ >= 0) t = t.slice(open);                                    // si hizo varias preguntas, quedarse con la última
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.endsWith('?') && t.indexOf('¿') < 0) t = '¿' + t;
    if (t.length > 220) t = t.slice(0, 217).trim() + '…';
    return t;
  }

  // context: { prompt, messages: [{ from, text }] }  → devuelve la pregunta, o { risk: true, text }
  async function ask(context, modelKey, onProgress, onToken) {
    const mine = context.messages.filter((m) => m.from !== 'ia');
    if (mine.slice(-3).some((m) => RISK.test(m.text))) return { risk: true, text: RISK_REPLY };
    const eng = await load(modelKey, onProgress);
    const recent = context.messages.slice(-8);
    const convo = [{ role: 'system', content: SYSTEM }];
    if (context.prompt) convo.push({ role: 'assistant', content: context.prompt });
    recent.forEach((m) => convo.push({ role: m.from === 'ia' ? 'assistant' : 'user', content: m.text }));
    try {
      let out = '';
      const stream = await eng.chat.completions.create({ messages: convo, temperature: 0.7, max_tokens: 90, stream: true });
      for await (const chunk of stream) {
        const d = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (d) { out += d; if (onToken) onToken(out); }
      }
      return { risk: false, text: clean(out) };
    } finally {
      try { await eng.resetChat(); } catch (e) {}
    }
  }

  root.DiarioAI = { MODELS, support, load, ask, isDownloaded, clean, RISK, RISK_REPLY };
})(window);
