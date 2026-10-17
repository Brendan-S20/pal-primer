import type { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/** What requireSupabaseAuth hands a handler, as far as a loader needs it: the
 *  caller's own client and id. A loader is a handler body that another
 *  handler can also call (see shell-context.functions.ts). */
export type AuthedContext = {
  supabase: ReturnType<typeof createClient<Database>>;
  userId: string;
};
