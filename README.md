# Profondo — neural bass rig

[![Build, test, deploy](https://github.com/MassimoDanieli/profondo/actions/workflows/ci.yml/badge.svg)](https://github.com/MassimoDanieli/profondo/actions/workflows/ci.yml)

A Neural Amp Modeler (NAM) rig for **bass**, running in the browser on **macOS, Windows and Linux**.
The engine is the official NeuralAmpModelerCore (A1 WaveNet, LSTM, A2 / slimmable) compiled to WebAssembly,
running inside an AudioWorklet. Output matches the native core within float rounding (~1e-4).

Models are parsed, built and prewarmed in a **Web Worker**; the audio thread only adopts a memory snapshot,
copied in 128 KB slices per render quantum into pre-created instances (≤1 ms per quantum measured), then crossfades.
Pedal and amp always get independent instances, even with the same capture.

## Run it

Audio input requires `https://` or `http://localhost`, so don't open `index.html` directly.

- **Mac**: double-click `Avvia Profondo (Mac).command` (first time: right-click → Open). Uses the built-in python3.
- **Windows**: double-click `Start Profondo (Windows).bat` (needs Python or Node).
- **Linux**: `./start-linux.sh`
- **Online**: `npx wrangler deploy` (Cloudflare, see `wrangler.jsonc`) or upload the `app/` folder to any static host (Cloudflare Pages, GitHub Pages, Netlify).

Best in **Chrome or Edge** (Web MIDI + output-device selection). Firefox works incl. MIDI; Safari runs the audio but has no Web MIDI.

## Chain

Gate → Compressor → Drive (blend) → **NAM pedal** → **NAM amp** → EQ (bass, low-mid, sweepable mid, treble, presence)
→ **Cab IR** → **Clean blend + crossover** → **Stereo tape delay** (ping-pong, sync, tap, wow, low cut) → **Stereo convolution reverb** → master + safety limiter.

Also: bass tuner (down to low B), loudness normalization from NAM metadata, presets with export/import (models embedded),
local model/IR library (IndexedDB — nothing uploaded), DSP load meter.

## MIDI

- **Learn**: LEARN → click any knob / switch / button → move or press the controller. Right-click clears.
- **Program Change** n → preset n+1. Models used by presets are preloaded, so switching is instant.
- **Expression**: map a CC to any knob.
- Switches: *press* (toggle per press) or *latch* (≥64 = on).
- **Tap tempo** mappable; **MIDI clock** follow for the synced delay.
- No controller: keyboard `1–9` blocks, `←/→` presets, `T` tap, `U` tuner, `B` bypass, `L` learn.

## Tips

- Set the audio interface to **48 kHz** (Mac: Audio MIDI Setup). NAM captures are trained at 48 kHz.
- Get captures and IRs at https://www.tone3000.com — drop `.nam` on the amp display or the NAM pedal, `.wav` on cab/reverb.
- X-OVER at ~150 Hz + BLEND keeps the lows clean under a dirty amp.
- **Clean alignment**: NAM captures and cab IRs delay and sometimes invert the signal, so mixing them with the clean DI
  can thin out the low end. Press **AUTO** (clean blend section) and play a few low notes: Profondo measures the
  amp + cab delay and polarity by cross-correlation and sets ALIGN (0–20 ms) and Ø PHASE. Both can be set by hand.
- **Engine rate** (Audio settings): 48 kHz by default; switch to 44.1/96 kHz if your captures were trained at that rate.
  A capture whose rate differs from the engine is flagged ⚠ (its frequency response would be shifted).

## Development

```sh
npm run deps         # wasi-sdk + NeuralAmpModelerCore + Eigen at the pinned commits (wasm/deps.env) into .deps/
npm run build:wasm   # app/nam.wasm (wasi-sdk clang, SIMD128 — no Emscripten)
npm run build:ref    # native reference build of the official core (g++)
npm i && npx playwright install chromium
npm test             # fidelity (wasm vs native, every example model) + end-to-end checks
npm start            # http://localhost:8765
```

| Path | |
| --- | --- |
| `app/` | the whole site (static): UI, Web Audio graph, AudioWorklet, loader worker, `nam.wasm` |
| `wasm/` | C ABI around the NAM core (`nam_wasm.cpp`), single-thread shims, build + dependency scripts |
| `tests/` | `fidelity.mjs` + `native-ref.cpp`, `e2e.mjs` (headless Chromium, fake audio input) |

**CI** (`.github/workflows/ci.yml`): every push and PR rebuilds `nam.wasm` from source, runs both test suites,
and on `main` deploys `app/` to Cloudflare Workers. Add the repository secrets `CLOUDFLARE_API_TOKEN`
(template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`. Tagging `v*` publishes a release zip with the launchers.

## License

MIT (see LICENSE). Third-party components: THIRD_PARTY.md.
