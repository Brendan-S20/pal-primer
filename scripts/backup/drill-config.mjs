// Moves the drill's throwaway Supabase stack onto its own ports and the
// Postgres major version production reported.
//
//   Used by patch-drill-config.mjs, the command drill.sh runs.
//
// `supabase init` wrote supabase/config.toml up to CLI v3.3.0 and writes
// supabase/config.jsonc from v3.4.0 (init --help: "Write a fresh
// supabase/config.jsonc ... removing any config.json or config.toml").
// The drill runs on `latest`, so it patches whichever one init left, and
// stops loudly if it left neither or if either has changed shape.
import fs from "node:fs";
import path from "node:path";

const FORMATS = [
  {
    file: "config.toml",
    majorLine: /^major_version = \d+$/m,
    majorOut: (m) => `major_version = ${m}`,
  },
  {
    file: "config.jsonc",
    majorLine: /^(\s*)"major_version": \d+,?$/m,
    majorOut: (m) => `"major_version": ${m},`,
    jsonc: true,
  },
];

export function patchDrillConfig(text, format, prefix, major) {
  const f = FORMATS.find((x) => x.file === format);
  if (!f) throw new Error(`unknown config format ${format}`);
  let ports = 0;
  let s = text.replace(/\b543(\d\d)\b/g, (_, d) => {
    ports += 1;
    return `${prefix}${d}`;
  });
  if (!f.majorLine.test(s)) {
    throw new Error(
      `${format} from \`supabase init\` has no major_version line to set; update patch-drill-config.mjs`,
    );
  }
  s = s.replace(f.majorLine, (line, indent) => {
    const keep = f.jsonc ? (indent ?? "") : "";
    const hadComma = f.jsonc && line.trimEnd().endsWith(",");
    return `${keep}${f.majorOut(major).replace(/,$/, hadComma ? "," : "")}`;
  });
  if (ports === 0) {
    throw new Error(
      `${format} from \`supabase init\` no longer uses 543xx ports; update patch-drill-config.mjs`,
    );
  }
  return { text: s, ports };
}

export function patchStackDir(stackdir, prefix, major) {
  const found = FORMATS.filter((x) => fs.existsSync(path.join(stackdir, "supabase", x.file)));
  if (found.length !== 1) {
    throw new Error(
      `\`supabase init --force\` left ${found.length === 0 ? "neither supabase/config.toml nor supabase/config.jsonc" : "both config.toml and config.jsonc"} in ${stackdir}; the CLI's init output has changed, update patch-drill-config.mjs`,
    );
  }
  const p = path.join(stackdir, "supabase", found[0].file);
  const out = patchDrillConfig(fs.readFileSync(p, "utf8"), found[0].file, prefix, major);
  fs.writeFileSync(p, out.text);
  return { file: found[0].file, ports: out.ports };
}
