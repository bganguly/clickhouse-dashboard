import { query } from "@/lib/clickhouse";
import { mapDbError } from "@/lib/errors";
import type { RegionOption } from "@/lib/types";

export async function listRegions(): Promise<RegionOption[]> {
  try {
    const rows = await query<{ regionId: string; code: string; name: string }>(
      `SELECT regionId, code, name FROM regions ORDER BY name ASC`,
    );
    return rows.map((r) => ({ id: Number(r.regionId), code: r.code, name: r.name }));
  } catch (err) {
    mapDbError(err, "listRegions");
  }
}
