// Stand-in for @tanstack/react-start when the release gate loads server
// functions from node. createServerFn hands back the handler itself, called
// with the caller context the gate sets (a real signed-in Supabase client).
export function createServerFn() {
  let validate = (d) => d;
  const b = {
    middleware: () => b,
    inputValidator: (v) => ((validate = v), b),
    validator: (v) => ((validate = v), b),
    handler:
      (h) =>
      async (opts = {}) => {
        const context = globalThis.__releaseGate?.context;
        if (!context) throw new Error("release gate: no caller context set");
        return h({ data: validate(opts.data), context });
      },
  };
  return b;
}

export function createMiddleware() {
  const m = {
    middleware: () => m,
    server: () => m,
    client: () => m,
    validator: () => m,
    inputValidator: () => m,
  };
  return m;
}
