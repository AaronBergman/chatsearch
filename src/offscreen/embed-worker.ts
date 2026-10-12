/**
 * Embedding worker: runs MongoDB/mdbr-leaf-ir (23M params, BEIR 53.6) through transformers.js.
 * WebGPU (fp16/fp32) when available, otherwise single-threaded WASM (int8).
 * Vectors are truncated to the first 256 dims (the model is MRL-trained) and re-normalized.
 */
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';

const MODEL_ID = 'MongoDB/mdbr-leaf-ir';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const DIMS = 256;

let tokenizer: any = null;
let model: any = null;
let device: 'webgpu' | 'wasm' = 'wasm';
let dtype = 'q8';
let loading: Promise<void> | null = null;

async function init(base: string, preferGpu: boolean) {
  if (loading) return loading;
  loading = (async () => {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    (env as any).useWasmCache = false;
    const onnx: any = env.backends.onnx;
    onnx.wasm.wasmPaths = { mjs: base + 'ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: base + 'ort/ort-wasm-simd-threaded.asyncify.wasm' };
    onnx.wasm.numThreads = 1;
    onnx.wasm.proxy = false;
    let gpuF16 = false;
    let gpuOk = false;
    if (preferGpu && (self as any).navigator?.gpu) {
      try {
        const adapter = await (self as any).navigator.gpu.requestAdapter();
        if (adapter) {
          gpuOk = true;
          gpuF16 = adapter.features?.has?.('shader-f16') ?? false;
        }
      } catch {
        gpuOk = false;
      }
    }
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
    const attempts: [typeof device, string][] = gpuOk ? [['webgpu', gpuF16 ? 'fp16' : 'fp32'], ['wasm', 'q8']] : [['wasm', 'q8']];
    let lastErr: unknown = null;
    for (const [dev, dt] of attempts) {
      try {
        model = await AutoModel.from_pretrained(MODEL_ID, { device: dev, dtype: dt as any });
        device = dev;
        dtype = dt;
        // warm-up (compiles shaders) and a quality self-test: some GPU drivers run without errors
        // but return garbage, which would silently poison the stored index
        if (!(await selfTest())) throw new Error(`${dev} ${dt} failed the embedding self-test`);
        return;
      } catch (e) {
        lastErr = e;
        model = null;
      }
    }
    throw lastErr ?? new Error('could not load embedding model');
  })();
  try {
    await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

async function selfTest(): Promise<boolean> {
  const q = await embed(['a cat napping in the sun'], true);
  const d = await embed(['My kitten sleeps by the window every afternoon.', 'Quarterly revenue grew 4 percent on strong bond trading.'], false);
  if (![...q, ...d].every(Number.isFinite)) return false;
  let a = 0;
  let b = 0;
  for (let j = 0; j < DIMS; j++) {
    a += q[j] * d[j];
    b += q[j] * d[DIMS + j];
  }
  return a > b + 0.05;
}

async function embed(texts: string[], query: boolean): Promise<Float32Array> {
  const inputs = await tokenizer(query ? texts.map((t) => QUERY_PREFIX + t) : texts, { padding: true, truncation: true, max_length: 512 });
  const out = await model(inputs);
  const e = out.sentence_embedding;
  const full = e.data as Float32Array;
  const fullDims = e.dims[1];
  const res = new Float32Array(texts.length * DIMS);
  for (let i = 0; i < texts.length; i++) {
    let n = 0;
    for (let j = 0; j < DIMS; j++) {
      const v = full[i * fullDims + j];
      n += v * v;
    }
    n = Math.sqrt(n) || 1;
    for (let j = 0; j < DIMS; j++) res[i * DIMS + j] = full[i * fullDims + j] / n;
  }
  e.dispose?.();
  out.last_hidden_state?.dispose?.();
  return res;
}

// One inference at a time: onnxruntime sessions must not run concurrently (overlapping runs can
// corrupt outputs). Queries jump ahead of background batches so search stays snappy.
interface Job {
  msg: any;
}
const jobs: Job[] = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (jobs.length) {
      const { msg } = jobs.shift()!;
      try {
        if (msg.type === 'init') {
          await init(msg.base, msg.preferGpu !== false);
          (self as any).postMessage({ type: 'ready', id: msg.id, device, dtype, dims: DIMS });
        } else if (msg.type === 'embed') {
          if (!model) await init(msg.base, msg.preferGpu !== false);
          const t0 = performance.now();
          const vecs = await embed(msg.texts, !!msg.query);
          (self as any).postMessage({ type: 'result', id: msg.id, vecs, ms: performance.now() - t0, device }, [vecs.buffer]);
        }
      } catch (e: any) {
        (self as any).postMessage({ type: 'error', id: msg.id, error: String(e?.message || e) });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'embed' && msg.query) {
    const at = jobs.findIndex((j) => !(j.msg.type === 'embed' && j.msg.query) && j.msg.type !== 'init');
    jobs.splice(at < 0 ? jobs.length : at, 0, { msg });
  } else jobs.push({ msg });
  pump();
};
