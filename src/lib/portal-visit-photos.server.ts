// Shared by walk reports and stay timelines. Only visit ids selected after
// the portal session and client checks may reach this helper.
export async function portalVisitPhotos(sb: any, visitIds: string[]) {
  const byVisit = new Map<string, Array<{ url: string; kind: string }>>();
  for (let i = 0; i < visitIds.length; i += 100) {
    const { data: photos, error } = await sb.from("visit_photos")
      .select("visit_id, storage_path, kind").in("visit_id", visitIds.slice(i, i + 100)).order("created_at");
    if (error) throw new Error(error.message);
    if (!photos?.length) continue;
    const { data: signed, error: signError } = await sb.storage.from("visit-photos")
      .createSignedUrls(photos.map((p: { storage_path: string }) => p.storage_path), 600);
    if (signError) throw new Error(signError.message);
    const urls = new Map<string, string>();
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
    for (const p of photos) {
      const url = urls.get(p.storage_path);
      if (!url) continue;
      const list = byVisit.get(p.visit_id) ?? [];
      list.push({ url, kind: p.kind });
      byVisit.set(p.visit_id, list);
    }
  }
  return byVisit;
}
