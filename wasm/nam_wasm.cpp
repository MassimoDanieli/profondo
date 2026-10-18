// Thin C ABI around NeuralAmpModelerCore for use inside an AudioWorklet.
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <typeinfo>
#include "NAM/get_dsp.h"
#include "NAM/dsp.h"

#define EXPORT extern "C" __attribute__((visibility("default")))

static std::unique_ptr<nam::DSP> g_dsp;
static float g_in[4096];
static float g_out[4096];
static char g_err[512] = {0};

#ifdef __wasm__
// ---- minimal C++ exception shim: a throw records the message and traps ----
extern "C" {
void* __cxa_allocate_exception(size_t sz) { return calloc(1, sz + 64); }
void __cxa_free_exception(void* p) { free(p); }
[[noreturn]] void __cxa_throw(void* obj, std::type_info* tinfo, void (*)(void*))
{
  const char* msg = "exception";
  // All throws in NAM / nlohmann derive from std::exception
  if (obj) msg = static_cast<std::exception*>(obj)->what();
  strncpy(g_err, msg ? msg : "exception", sizeof(g_err) - 1);
  __builtin_trap();
}
void* __cxa_begin_catch(void* p) { return p; }
void __cxa_end_catch() {}
[[noreturn]] void __cxa_rethrow() { __builtin_trap(); }
}
#endif

EXPORT const char* nam_error() { return g_err; }
EXPORT char* nam_alloc(int n) { return (char*)malloc(n + 1); }
EXPORT void nam_free(char* p) { free(p); }
EXPORT float* nam_in() { return g_in; }
EXPORT float* nam_out() { return g_out; }

// returns 1 on success
EXPORT int nam_load(char* json, int len, double sampleRate, int maxBlock)
{
  g_err[0] = 0;
  json[len] = 0;
  nlohmann::json j = nlohmann::json::parse(json, json + len);
  // Loading (and the core's own prewarm inside Reset) runs in the loader Web Worker, never on the audio thread.
  g_dsp = nam::get_dsp(j);
  if (!g_dsp) { strcpy(g_err, "unsupported model"); return 0; }
  g_dsp->Reset(sampleRate, maxBlock);
  return 1;
}

EXPORT double nam_expected_rate() { return g_dsp ? g_dsp->GetExpectedSampleRate() : -1; }
EXPORT double nam_loudness() { return (g_dsp && g_dsp->HasLoudness()) ? g_dsp->GetLoudness() : 999.0; }
EXPORT double nam_input_level() { return (g_dsp && g_dsp->HasInputLevel()) ? g_dsp->GetInputLevel() : 999.0; }
EXPORT double nam_output_level() { return (g_dsp && g_dsp->HasOutputLevel()) ? g_dsp->GetOutputLevel() : 999.0; }

EXPORT int nam_prewarm_samples() { return g_dsp ? g_dsp->GetPrewarmSamples() : 0; }

EXPORT void nam_process(int n)
{
  if (!g_dsp) { memcpy(g_out, g_in, n * sizeof(float)); return; }
  float* in[1] = {g_in};
  float* out[1] = {g_out};
  g_dsp->process(in, out, n);
}
