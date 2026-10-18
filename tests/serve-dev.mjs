import { serve } from './serve.mjs';
const s = await serve(new URL('../app', import.meta.url).pathname, new URL('../.deps/NeuralAmpModelerCore/example_models', import.meta.url).pathname, 8765);
console.log('Profondo →', s.url);
