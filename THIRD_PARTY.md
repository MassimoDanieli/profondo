# Third-party code in app/nam.wasm

- NeuralAmpModelerCore — Steven Atkinson and contributors, MIT — https://github.com/sdatkinson/NeuralAmpModelerCore (commit in `wasm/deps.env`)
- Eigen — MPL-2.0 — https://eigen.tuxfamily.org (commit in `wasm/deps.env`; unmodified source, available at that commit)
- nlohmann/json — MIT
- wasi-libc / LLVM libc++ (via wasi-sdk) — Apache-2.0 with LLVM exception / MIT

No NAM captures or impulse responses are bundled: the built-in cabinets and rooms are synthesized at runtime.
The tests use the example models shipped with NeuralAmpModelerCore, fetched at build time.
