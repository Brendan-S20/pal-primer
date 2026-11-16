// A directory photo is moderated on the TEST org (#630; mypets v2 step 5b),
// against the real local stack: real Postgres, real RLS, real Storage, the
// real Settings page and /d/{slug}/photos/{key} route behind the dev server.
//
// Only the e2e org seed.mjs builds (e2eOrgId), only a local database
// (serviceDb refuses anything else), and every name it makes is labelled
// TEST. The images are 1x1 PNGs made here, not photographs. Nothing reaches
// production. Everything it writes is removed in `finally`.
//
//   1. The OWNER uploads one photo through Settings → Directory listing: the
//      Upload button stays off until the attestation is ticked, and the row
//      it writes is pending with rights_attested_at set. Three more go in on
//      the owner's own client; one without the attestation is refused.
//   2. Pending: a visitor reads no photos, and no photo URL serves anything.
//   3. A MODERATOR (a platform admin made for this run) reads the queue and
//      approves three. A visitor then reads exactly those three, each with
//      its alt, never the pending one, and nothing of a storage path or the
//      org id; each URL serves the PNG; the pending one's is a 404.
//   4. The moderator rejects one: it leaves the listing and its URL is a 404.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, signIn, waitForHydration } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SLUG = "e2e-photo-listing";
const BUCKET = "directory-photos";
const ATTESTATION = "I took these or have the rights to use them, and they are not AI-generated";

/** A real 1x1 PNG of one colour. */
function png(rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, ...rgb]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const keyOf = (id: string) =>
  createHash("md5").update(`directory-photo:${id}`).digest("hex").slice(0, 16);

type Photo = { url: string; alt: string; position: number };

test("a directory photo is public only after a moderator approves it, on the test org", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await owner.auth.signInWithPassword(OWNER);
  if (signInErr) throw new Error(`owner sign-in: ${signInErr.message}`);

  const modEmail = `photo-moderator-${Date.now()}@example.test`;
  const modPassword = `e2e-moderator-${Date.now()}`;
  let modId: string | null = null;
  const serviceIds: string[] = [];

  try {
    // ── A published TEST profile ──────────────────────────────────────────
    const { data: svc, error: svcErr } = await db
      .from("services")
      .insert({
        organization_id: orgId,
        name: "Photo walk (TEST)",
        service_line: "dog_walking",
        price_unit: "visit",
        base_price_cents: 2500,
        extra_pet_cents: 0,
        default_duration_min: 30,
        active: true,
      })
      .select("id")
      .single();
    if (svcErr) throw new Error(`making the TEST service: ${svcErr.message}`);
    serviceIds.push(svc!.id as string);
    const { error: pubErr } = await owner.rpc("set_directory_profile", {
      _org: orgId,
      _slug: SLUG,
      _display_name: "E2E Directory Photos (TEST)",
      _bio: "A test listing.",
      _show_logo: false,
      _coverage_zips: ["48067"],
      _coverage_cities: ["Royal Oak"],
      _services: [{ service_id: svc!.id, price_from_cents: 2500 }],
      _published: true,
    });
    expect(pubErr?.message ?? null, "the owner publishes").toBeNull();

    const visitor = createClient(URL_, ANON, { auth: { persistSession: false } });
    const listing = async () => {
      const { data, error } = await visitor
        .from("directory_public_listings")
        .select("*")
        .eq("slug", SLUG)
        .single();
      expect(error?.message ?? null).toBeNull();
      return data as Record<string, unknown> & { photos: Photo[] };
    };

    // ── 1. The owner uploads one through Settings ─────────────────────────
    await signIn(page);
    await page.goto("/settings/directory");
    const add = page.locator("[data-directory-photo-add]");
    await expect(add).toBeVisible({ timeout: 30_000 });
    await waitForHydration(page, "[data-directory-photo-add] input[type=file]");
    await add.getByLabel("Photo", { exact: true }).setInputFiles({
      name: "gate.png",
      mimeType: "image/png",
      buffer: png([156, 184, 168]),
    });
    await add.getByLabel("Description of this photo").fill("Gate latched after a visit (TEST)");
    const upload = add.getByRole("button", { name: "Upload photo" });
    await expect(upload, "no upload without the attestation").toBeDisabled();
    await expect(add.locator("[data-directory-photo-attestation]")).toHaveText(ATTESTATION);
    await add.getByRole("checkbox").check();
    await upload.click();
    await expect(page.locator("[data-directory-photo=pending]")).toHaveCount(1, {
      timeout: 30_000,
    });
    const { data: first } = await db
      .from("directory_profile_photos")
      .select("id, path, alt, status, rights_attested_at")
      .eq("organization_id", orgId);
    expect(first).toHaveLength(1);
    expect(first![0]).toMatchObject({
      alt: "Gate latched after a visit (TEST)",
      status: "pending",
    });
    expect(first![0].rights_attested_at).toBeTruthy();
    expect(String(first![0].path).startsWith(`${orgId}/`)).toBe(true);
    // Whatever was chosen, what went up is a JPEG redrawn in the browser.
    expect(String(first![0].path).endsWith(".jpg")).toBe(true);

    // Three more on the owner's own client, and one with no attestation.
    const more: Array<[string, [number, number, number]]> = [
      ["Clean back lawn (TEST)", [201, 183, 156]],
      ["Our van at the curb (TEST)", [163, 180, 200]],
      ["Bagged waste by the bin (TEST)", [180, 160, 200]],
    ];
    for (const [i, [alt, rgb]] of more.entries()) {
      const path = `${orgId}/${crypto.randomUUID()}.png`;
      const { error: upErr } = await owner.storage
        .from(BUCKET)
        .upload(path, png(rgb), { contentType: "image/png", upsert: false });
      expect(upErr?.message ?? null, `upload ${alt}`).toBeNull();
      const { error } = await owner.from("directory_profile_photos").insert({
        organization_id: orgId,
        path,
        alt,
        position: i + 1,
        rights_attested_at: new Date().toISOString(),
      });
      expect(error?.message ?? null, `insert ${alt}`).toBeNull();
    }
    const { error: noAttest } = await owner.from("directory_profile_photos").insert({
      organization_id: orgId,
      path: `${orgId}/${crypto.randomUUID()}.png`,
      alt: "No attestation (TEST)",
      position: 9,
    });
    expect(noAttest?.message ?? "", "refused without the attestation").toMatch(/AI-generated/);

    // ── 2. Pending: nothing public ────────────────────────────────────────
    expect((await listing()).photos).toEqual([]);
    const { data: rows } = await db
      .from("directory_profile_photos")
      .select("id, alt")
      .eq("organization_id", orgId);
    const id = (alt: string) => rows!.find((r) => r.alt === alt)!.id as string;
    for (const r of rows!) {
      const res = await request.get(`/d/${SLUG}/photos/${keyOf(r.id as string)}`);
      expect(res.status(), `pending ${r.alt}`).toBe(404);
    }

    // ── 3. A moderator approves three ─────────────────────────────────────
    const { data: made, error: mkErr } = await db.auth.admin.createUser({
      email: modEmail,
      password: modPassword,
      email_confirm: true,
    });
    if (mkErr) throw new Error(`making the TEST moderator: ${mkErr.message}`);
    modId = made.user!.id;
    const { error: paErr } = await db.from("platform_admins").insert({ user_id: modId });
    if (paErr) throw new Error(`platform_admins: ${paErr.message}`);
    const moderator = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: modSignIn } = await moderator.auth.signInWithPassword({
      email: modEmail,
      password: modPassword,
    });
    if (modSignIn) throw new Error(`moderator sign-in: ${modSignIn.message}`);

    // The owner cannot approve their own, by RPC or by column.
    const { error: selfRpc } = await owner.rpc("moderate_directory_photo", {
      _id: id("Clean back lawn (TEST)"),
      _approve: true,
    });
    expect(selfRpc?.message ?? "").toMatch(/moderator/);
    const { error: selfCol } = await owner
      .from("directory_profile_photos")
      .update({ status: "approved" })
      .eq("id", id("Clean back lawn (TEST)"));
    expect(selfCol, "the owner cannot write status").not.toBeNull();

    const { data: queue, error: qErr } = await moderator.rpc("directory_photo_queue", {
      _status: "pending",
    });
    expect(qErr?.message ?? null).toBeNull();
    const mine = (queue as Array<{ alt: string; profile_slug: string }>).filter(
      (q) => q.profile_slug === SLUG,
    );
    expect(mine.map((q) => q.alt).sort()).toEqual(rows!.map((r) => r.alt).sort());
    for (const alt of [
      "Gate latched after a visit (TEST)",
      "Clean back lawn (TEST)",
      "Our van at the curb (TEST)",
    ]) {
      const { error } = await moderator.rpc("moderate_directory_photo", {
        _id: id(alt),
        _approve: true,
      });
      expect(error?.message ?? null, `approve ${alt}`).toBeNull();
    }

    const row = await listing();
    expect(row.photos.map((p) => p.alt)).toEqual([
      "Gate latched after a visit (TEST)",
      "Clean back lawn (TEST)",
      "Our van at the curb (TEST)",
    ]);
    for (const p of row.photos) {
      expect(Object.keys(p).sort()).toEqual(["alt", "position", "url"]);
      expect(p.url).toMatch(new RegExp(`^/d/${SLUG}/photos/[0-9a-f]{16}$`));
    }
    const blob = JSON.stringify(row);
    expect(blob).not.toContain(orgId);
    expect(blob).not.toMatch(/\.png|directory-photos|storage|Bagged waste|Photo by|Pexels/i);
    for (const p of row.photos) {
      const res = await request.get(p.url);
      expect(res.status(), p.alt).toBe(200);
      expect(res.headers()["location"]).toBeUndefined();
      const bytes = await res.body();
      if (p.alt === "Gate latched after a visit (TEST)") {
        // Uploaded through Settings: redrawn in the browser as a JPEG, so
        // nothing but pixels went up, and nothing but pixels comes back.
        expect(res.headers()["content-type"]).toBe("image/jpeg");
        expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
        expect(bytes.includes(Buffer.from("Exif"))).toBe(false);
      } else {
        expect(res.headers()["content-type"]).toBe("image/png");
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      }
    }
    // The swap the review of 04649ef4 found: delete an approved photo's file
    // and upload other bytes under its name. Through the real Storage API,
    // the delete removes nothing and the upload is refused; the photo still
    // serves its approved bytes.
    const { data: approvedRow } = await db
      .from("directory_profile_photos")
      .select("path")
      .eq("id", id("Clean back lawn (TEST)"))
      .single();
    const approvedPath = approvedRow!.path as string;
    const served = async () =>
      Buffer.from(await (await request.get(row.photos[1].url)).body()).toString("hex");
    const before = await served();
    const { data: removed } = await owner.storage.from(BUCKET).remove([approvedPath]);
    expect(removed ?? [], "an approved photo's file cannot be deleted").toEqual([]);
    const { error: swapErr } = await owner.storage
      .from(BUCKET)
      .upload(approvedPath, png([255, 0, 0]), { contentType: "image/png", upsert: true });
    expect(swapErr, "nothing can be uploaded over an approved photo").not.toBeNull();
    expect(await served()).toBe(before);

    const pending = await request.get(
      `/d/${SLUG}/photos/${keyOf(id("Bagged waste by the bin (TEST)"))}`,
    );
    expect(pending.status()).toBe(404);

    // ── 4. Rejected: off the listing, and its URL stops serving ───────────
    const { error: rejErr } = await moderator.rpc("moderate_directory_photo", {
      _id: id("Our van at the curb (TEST)"),
      _approve: false,
    });
    expect(rejErr?.message ?? null).toBeNull();
    expect((await listing()).photos.map((p) => p.alt)).toEqual([
      "Gate latched after a visit (TEST)",
      "Clean back lawn (TEST)",
    ]);
    const rejected = await request.get(
      `/d/${SLUG}/photos/${keyOf(id("Our van at the curb (TEST)"))}`,
    );
    expect(rejected.status()).toBe(404);
    const { data: decided } = await db
      .from("directory_profile_photos")
      .select("status, moderated_by, moderated_at")
      .eq("id", id("Our van at the curb (TEST)"))
      .single();
    expect(decided).toMatchObject({ status: "rejected", moderated_by: modId });
    expect(decided!.moderated_at).toBeTruthy();
    await moderator.auth.signOut();
  } finally {
    const { data: left } = await db
      .from("directory_profile_photos")
      .select("path")
      .eq("organization_id", orgId);
    const paths = (left ?? []).map((r) => r.path as string);
    if (paths.length) await db.storage.from(BUCKET).remove(paths);
    await db.from("directory_profile_photos").delete().eq("organization_id", orgId);
    await db.from("directory_profiles").delete().eq("organization_id", orgId);
    if (serviceIds.length) await db.from("services").delete().in("id", serviceIds);
    if (modId) {
      await db.from("platform_admins").delete().eq("user_id", modId);
      await db.auth.admin.deleteUser(modId);
    }
    await owner.auth.signOut();
  }
});
