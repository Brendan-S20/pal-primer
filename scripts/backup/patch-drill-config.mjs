// The command drill.sh runs, after `supabase init --force` in the stack dir:
//
//   node patch-drill-config.mjs <stackdir> <port-prefix> <pg-major>
//
// It always does the patch or exits non-zero. There is deliberately no
// "am I the main module" guard: such a guard compares paths, and a symlinked
// path made it false, so the script exited 0 having patched nothing. The
// functions live in drill-config.mjs, which has no side effects on import.
import { patchStackDir } from "./drill-config.mjs";

const [stackdir, prefix, major] = process.argv.slice(2);
try {
  if (!stackdir || !/^\d{3}$/.test(prefix ?? "") || !/^\d+$/.test(major ?? "")) {
    throw new Error(
      "usage: patch-drill-config.mjs <stackdir> <3-digit port prefix> <postgres major>",
    );
  }
  const r = patchStackDir(stackdir, prefix, major);
  console.log(`drill stack: ${r.file}, ports ${prefix}xx, Postgres ${major}`);
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(1);
}
