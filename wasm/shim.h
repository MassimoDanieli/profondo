// Single-threaded shims for wasm32-wasip1 (libc++ built without threads).
#pragma once
#ifdef __cplusplus
#include <memory>
#include <atomic>
namespace std {
struct mutex { void lock() {} void unlock() {} bool try_lock() { return true; } };
template <class T> shared_ptr<T> atomic_load_explicit(const shared_ptr<T>* p, memory_order) { return *p; }
template <class T> void atomic_store_explicit(shared_ptr<T>* p, shared_ptr<T> v, memory_order) { *p = std::move(v); }
template <class T> shared_ptr<T> atomic_exchange_explicit(shared_ptr<T>* p, shared_ptr<T> v, memory_order) { auto o = std::move(*p); *p = std::move(v); return o; }
}
#endif
