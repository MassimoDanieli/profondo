// Native reference: the official NeuralAmpModelerCore, same test signal and block size as tests/fidelity.mjs.
#include <cmath>
#include <cstdio>
#include "NAM/get_dsp.h"
int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: native-ref model.nam out.f32\n"); return 2; }
  auto dsp = nam::get_dsp(std::filesystem::path(argv[1]));
  dsp->Reset(48000, 128); // prewarms with silence in 128-sample blocks
  FILE* o = fopen(argv[2], "wb");
  float in[128], out[128]; float* ip[1] = {in}; float* op[1] = {out};
  for (int b = 0; b < 400; b++) {
    for (int i = 0; i < 128; i++) { int t = b * 128 + i; in[i] = 0.3f * sinf(t * 0.01f + t * (float)t * 1e-7f) + 0.05f * sinf(t * 0.37f); }
    dsp->process(ip, op, 128); fwrite(out, 4, 128, o);
  }
  fclose(o); return 0;
}
