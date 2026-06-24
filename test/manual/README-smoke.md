/**
 * L1/L2/L3 real-world usage smoke scripts.
 *
 * These are NOT unit tests — they exercise the new features against realistic
 * data (real skill dirs, real keypress sequences, real event-log lifecycles)
 * and print human-readable proof that each feature works as advertised.
 *
 * Run individually:
 *   node --input-type=module test/manual/l3-skill-discovery-smoke.mjs
 *   node --input-type=module test/manual/l2-keybinding-dispatch-smoke.mjs
 *   node --input-type=module test/manual/l1-event-replay-smoke.mjs
 *
 * Or all three:
 *   for f in test/manual/l{1,2,3}-*-smoke.mjs; do node --input-type=module "$f"; done
 */
