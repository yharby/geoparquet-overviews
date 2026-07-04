import { FILE_PRESETS, type FilePreset } from './presets';

// The hosted test-data catalog. One JSON file at the prefix root lists every
// published data version and its datasets, so the viewer can offer a version
// dropdown and byte-cost comparisons across converter releases without a
// rebuild. Fetch failures degrade to the built-in presets, never to an error.
export interface ManifestDataset {
  id: string;
  label: string;
  path: string;
}

export interface ManifestVersion {
  version: string;
  prefix: string;
  spec?: string;
  datasets: ManifestDataset[];
}

export interface VersionManifest {
  latest: string;
  base: string;
  versions: ManifestVersion[];
}

export const MANIFEST_URL = 'https://data.source.coop/youssef-harby/geoparquet-overviews/versions.json';

function isDataset(d: unknown): d is ManifestDataset {
  const x = d as ManifestDataset;
  return !!x && typeof x.id === 'string' && typeof x.label === 'string' && typeof x.path === 'string';
}

function isVersion(v: unknown): v is ManifestVersion {
  const x = v as ManifestVersion;
  return (
    !!x &&
    typeof x.version === 'string' &&
    typeof x.prefix === 'string' &&
    Array.isArray(x.datasets) &&
    x.datasets.every(isDataset)
  );
}

export function parseManifest(raw: unknown): VersionManifest | null {
  const m = raw as VersionManifest;
  if (!m || typeof m.latest !== 'string' || typeof m.base !== 'string') return null;
  if (!Array.isArray(m.versions) || m.versions.length === 0 || !m.versions.every(isVersion)) return null;
  return { latest: m.latest, base: m.base.replace(/\/$/, ''), versions: m.versions };
}

export function presetsForVersion(manifest: VersionManifest, version: string): FilePreset[] {
  const entry = manifest.versions.find((v) => v.version === version);
  if (!entry) return [];
  return entry.datasets.map((d) => ({
    id: d.id,
    label: d.label,
    url: `${manifest.base}/${entry.prefix}/${d.path}`,
  }));
}

// The presets to offer for one version: that version's manifest datasets when
// it has any, else the built-in FILE_PRESETS. Mirrors LoadControl.presets(),
// pulled out here so the twin-matching below (and its tests) can call it
// without a DOM environment.
function presetsForVersionOrFallback(manifest: VersionManifest, version: string): FilePreset[] {
  if (version) {
    const fromManifest = presetsForVersion(manifest, version);
    if (fromManifest.length > 0) return fromManifest;
  }
  return FILE_PRESETS;
}

// Resolve the counterpart dataset URL when switching from one data version to
// another. Finds the currently-loaded dataset by matching `currentUrl` against
// `fromVersion`'s presets, then looks up that same preset id in `toVersion`'s
// presets. Returns null when the current URL is not a known preset of
// `fromVersion`, or when `toVersion` has no dataset with the same id (e.g. a
// dataset dropped between releases).
export function resolveVersionTwin(
  manifest: VersionManifest,
  fromVersion: string,
  toVersion: string,
  currentUrl: string,
): string | null {
  const fromPresets = presetsForVersionOrFallback(manifest, fromVersion);
  const currentId = fromPresets.find((p) => p.url === currentUrl)?.id ?? null;
  if (!currentId) return null;
  const toPresets = presetsForVersionOrFallback(manifest, toVersion);
  const twin = toPresets.find((p) => p.id === currentId);
  return twin ? twin.url : null;
}

export async function fetchManifest(url = MANIFEST_URL): Promise<VersionManifest | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseManifest(await res.json());
  } catch {
    return null;
  }
}
