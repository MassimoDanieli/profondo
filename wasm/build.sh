#!/usr/bin/env bash
# Build app/nam.wasm from NeuralAmpModelerCore with wasi-sdk (no Emscripten).
# Run wasm/fetch-deps.sh first, or set WASI_SDK / NAM_CORE / EIGEN.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=${WASI_SDK:-$ROOT/.deps/wasi-sdk}; N=${NAM_CORE:-$ROOT/.deps/NeuralAmpModelerCore}; E=${EIGEN:-$ROOT/.deps/eigen}
OUT=${OUT:-$ROOT/app/nam.wasm}; OBJ=$ROOT/.deps/obj; mkdir -p "$OBJ"
CXX="$W/bin/clang++ --target=wasm32-wasip1 --sysroot=$W/share/wasi-sysroot"
FL="-std=c++20 -O3 -msimd128 -fexceptions -include $ROOT/wasm/shim.h -DNAM_SAMPLE_FLOAT -DNAM_ENABLE_A2_FAST -DEIGEN_DONT_PARALLELIZE -DEIGEN_NO_DEBUG -DNDEBUG -DEIGEN_VECTORIZE_GENERIC -DEIGEN_GENERIC_VECTOR_SIZE_BYTES=16 -I$N -I$N/NAM -I$N/Dependencies/nlohmann -isystem $E"
SRC=$(ls $N/NAM/*.cpp $N/NAM/wavenet/*.cpp; echo $ROOT/wasm/nam_wasm.cpp)
pids=(); JOBS=${JOBS:-4}
for f in $SRC; do
  $CXX $FL -c "$f" -o "$OBJ/$(basename "$f" .cpp).o" & pids+=($!)
  if [ ${#pids[@]} -ge $JOBS ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
done
for p in "${pids[@]}"; do wait "$p"; done
$CXX -O3 -msimd128 -mexec-model=reactor "$OBJ"/*.o -o "$OUT" \
  -Wl,--export-dynamic -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--initial-memory=2097152
echo "built $OUT ($(wc -c < "$OUT") bytes)"
