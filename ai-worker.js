/* Mi Diario — IA local. Corre el modelo en un hilo aparte para que la app no se congele.
   Todo ocurre en este dispositivo: nada de lo que escribes se envía a internet. */
import { WebWorkerMLCEngineHandler } from 'https://esm.run/@mlc-ai/web-llm@0.2.86';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
