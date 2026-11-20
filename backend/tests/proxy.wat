;; Test-only canister. `go` takes raw bytes: [callee principal (10 bytes)] ++
;; [candid args]. It calls `managed_ai_completion` on the callee with 2e10
;; cycles attached and replies with the callee's raw reply (or rejects).
(module
  (import "ic0" "msg_arg_data_size" (func $arg_size (result i32)))
  (import "ic0" "msg_arg_data_copy" (func $arg_copy (param i32 i32 i32)))
  (import "ic0" "call_new" (func $call_new (param i32 i32 i32 i32 i32 i32 i32 i32)))
  (import "ic0" "call_data_append" (func $call_data (param i32 i32)))
  (import "ic0" "call_cycles_add128" (func $cycles_add (param i64 i64)))
  (import "ic0" "call_perform" (func $perform (result i32)))
  (import "ic0" "msg_reply_data_append" (func $reply_append (param i32 i32)))
  (import "ic0" "msg_reply" (func $reply))
  (import "ic0" "msg_reject" (func $reject (param i32 i32)))
  (memory (export "memory") 2)
  (data (i32.const 0) "managed_ai_completion")
  (data (i32.const 32) "call failed")
  (global $n (mut i32) (i32.const 0))

  (func $on_reply (param i32)
    (local $size i32)
    (local.set $size (call $arg_size))
    (call $arg_copy (i32.const 65536) (i32.const 0) (local.get $size))
    (call $reply_append (i32.const 65536) (local.get $size))
    (call $reply))
  (func $on_reject (param i32)
    (call $reject (i32.const 32) (i32.const 11)))

  (func $go
    (global.set $n (call $arg_size))
    (call $arg_copy (i32.const 4096) (i32.const 0) (global.get $n))
    (call $call_new
      (i32.const 4096) (i32.const 10)
      (i32.const 0) (i32.const 21)
      (i32.const 0) (i32.const 0)
      (i32.const 1) (i32.const 0))
    (call $call_data (i32.const 4106) (i32.sub (global.get $n) (i32.const 10)))
    (call $cycles_add (i64.const 0) (i64.const 20000000000))
    (drop (call $perform)))

  (table funcref (elem $on_reply $on_reject))
  (func (export "canister_update go") (call $go)))
