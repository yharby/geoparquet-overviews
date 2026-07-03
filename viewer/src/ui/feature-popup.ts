// The HTML for the feature popup shown when a geometry is clicked. Kept as plain
// strings because MapLibre's Popup takes an HTML string, not a DOM node, so the
// map owns the popup lifecycle. Every attribute key and value is escaped, since
// they come from arbitrary file contents, not from the app.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// Render one attribute value as display text. Parquet INT64 columns arrive as
// bigint, which JSON cannot stringify, so bigints (including any nested in a
// struct or list value) are turned into decimal strings first.
function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// The popup body while the attribute read is in flight. `row` is a resolved row
// ordinal (a number), so it is safe to interpolate directly.
export function featureLoadingHtml(row: number): string {
  return `<div class="feature-popup"><div class="fp-head">row ${row}</div><div class="fp-note">loading attributes…</div></div>`;
}

// The popup body once the attribute read fails.
export function featureErrorHtml(row: number, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<div class="feature-popup"><div class="fp-head">row ${row}</div><div class="fp-note fp-error">${escapeHtml(msg)}</div></div>`;
}

// The popup body with the feature's attribute columns as a two-column table.
export function featureAttributesHtml(row: number, attrs: Record<string, unknown>): string {
  const keys = Object.keys(attrs);
  const body =
    keys.length === 0
      ? `<div class="fp-note">no attribute columns</div>`
      : `<table class="fp-table"><tbody>${keys
          .map(
            (k) =>
              `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(formatValue(attrs[k]))}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return `<div class="feature-popup"><div class="fp-head">row ${row}</div>${body}</div>`;
}
