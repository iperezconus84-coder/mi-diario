/* Mi Diario — preguntas de seguimiento con IA que corre en el celular.
   Con aceleración gráfica usa WebLLM (más rápido). Si el celular no la ofrece,
   usa wllama con el procesador normal y el modelo ligero (más lento, funciona en casi todos).
   El modelo se descarga una sola vez y queda guardado en el navegador.
   Lo que escribes nunca sale del dispositivo. */
(function (root) {
  'use strict';
  const LIB = 'https://esm.run/@mlc-ai/web-llm@0.2.86';
  const CPU_LIB = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/index.js';
  const CPU_WASM = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/wasm/wllama.wasm';
  const CPU_MODEL = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf';
  const CPU_SIZE = 'unos 500 MB';

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
  // Versión corta para el modo procesador: menos texto que leer = respuesta mucho más rápida.
  const SYSTEM_CPU = 'Eres un diario personal. Responde solo con UNA pregunta breve, cálida y abierta, en español, para que la persona profundice en lo que escribió. Sin consejos, sin saludos.';

  let engine = null, loading = null, loadedId = null;
  let cpu = null, cpuLoading = null;

  // gpu: true → WebLLM con aceleración gráfica; gpu: false → modo procesador (wllama)
  async function support() {
    const cpuOk = typeof WebAssembly === 'object' && typeof Worker === 'function';
    const viaCPU = (why) => cpuOk
      ? { ok: true, gpu: false, why }
      : { ok: false, why: 'Este navegador no puede correr la IA. Usa Chrome actualizado.' };
    if (!navigator.gpu) return viaCPU('Este navegador no tiene aceleración gráfica para la IA.');
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return viaCPU('Tu celular no ofrece aceleración gráfica para la IA.');
      return { ok: true, gpu: true, f16: adapter.features.has('shader-f16') };
    } catch (e) {
      return viaCPU('No pude acceder a la aceleración gráfica de este celular.');
    }
  }

  /* --- Modo procesador (wllama) --- */
  async function cpuInstance() {
    if (cpu) return cpu;
    const lib = await import(CPU_LIB);
    cpu = new lib.Wllama({ default: CPU_WASM }, { suppressNativeLog: true });
    return cpu;
  }
  async function loadCPU(onProgress) {
    const w = await cpuInstance();
    if (w.isModelLoaded()) return w;
    if (cpuLoading) return cpuLoading;
    cpuLoading = (async () => {
      await w.loadModelFromUrl(CPU_MODEL, {
        n_ctx: 1024, n_gpu_layers: 0,
        progressCallback: ({ loaded, total }) => { if (onProgress && total) onProgress(Math.min(99, Math.round((loaded / total) * 100)), ''); }
      });
      if (onProgress) onProgress(100, '');
      try { root.DiarioAI.threads = w.isMultithread() ? (w.nbThreads || 'varios') : 1; } catch (e) {}
      return w;
    })();
    try { return await cpuLoading; }
    catch (e) {
      try { await w.exit(); } catch (x) {}
      cpu = null;
      throw new Error('No pude preparar la IA: ' + (e.message || e));
    } finally { cpuLoading = null; }
  }

  async function load(modelKey, onProgress) {
    const m = MODELS[modelKey] || MODELS.recomendado;
    const s = await support();
    if (!s.ok) throw new Error(s.why);
    if (!s.gpu) return { cpu: await loadCPU(onProgress) };
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
      if (!s.gpu) {
        const w = await cpuInstance();
        const name = await w.cacheManager.getNameFromURL(CPU_MODEL);
        return (await w.cacheManager.getSize(name)) > 0;
      }
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
  // onStage('cargando' | 'pensando'); signal: AbortSignal para cancelar
  async function ask(context, modelKey, onProgress, onToken, onStage, signal) {
    const mine = context.messages.filter((m) => m.from !== 'ia');
    if (mine.slice(-3).some((m) => RISK.test(m.text))) return { risk: true, text: RISK_REPLY };
    if (onStage) onStage('cargando');
    const eng = await load(modelKey, onProgress);
    if (signal && signal.aborted) throw new DOMException('cancelado', 'AbortError');
    const isCPU = !!(eng && eng.cpu);
    if (onStage) onStage('pensando');
    if (isCPU && !mine.length) return { risk: false, text: '' };
    let convo;
    if (isCPU) {
      const last = mine[mine.length - 1];
      const t = last.text.length > 400 ? '…' + last.text.slice(-400) : last.text;
      convo = [{ role: 'system', content: SYSTEM_CPU }, { role: 'user', content: t }];
    } else {
      convo = [{ role: 'system', content: SYSTEM }];
      if (context.prompt) convo.push({ role: 'assistant', content: context.prompt });
      context.messages.slice(-8).forEach((m) => convo.push({ role: m.from === 'ia' ? 'assistant' : 'user', content: m.text }));
    }
    try {
      let out = '';
      const req = { messages: convo, temperature: 0.7, max_tokens: isCPU ? 60 : 90, stream: true };
      let stream;
      if (isCPU) { if (signal) req.abortSignal = signal; stream = await eng.cpu.createChatCompletion(req); }
      else {
        if (signal) signal.addEventListener('abort', () => { try { eng.interruptGenerate(); } catch (e) {} }, { once: true });
        stream = await eng.chat.completions.create(req);
      }
      for await (const chunk of stream) {
        const d = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (signal && signal.aborted) break;
        if (d) { out += d; if (onToken) onToken(out); }
      }
      if (signal && signal.aborted) throw new DOMException('cancelado', 'AbortError');
      return { risk: false, text: clean(out) };
    } finally {
      if (!isCPU) { try { await eng.resetChat(); } catch (e) {} }
    }
  }

  root.DiarioAI = { MODELS, CPU_SIZE, support, load, ask, isDownloaded, clean, RISK, RISK_REPLY };
})(window);
