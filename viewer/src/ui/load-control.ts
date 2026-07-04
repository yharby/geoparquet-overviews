import { LitElement, html } from 'lit';
import { FILE_PRESETS, initialUrl, type FilePreset } from '../data/presets';
import { fetchManifest, presetsForVersion, resolveVersionTwin, type VersionManifest } from '../data/manifest';

export interface FileLoadRequest {
  url: string;
}

export class LoadControl extends LitElement {
  static properties = {
    busy: { type: Boolean },
    manifest: { attribute: false },
    version: { state: true },
  };

  // `declare` erases this field at compile time so TypeScript's ES2022
  // class-field emit does not shadow the reactive accessor Lit installs on
  // the prototype for properties named in `static properties`. Initializing
  // `busy = false` as a normal class field here throws Lit's
  // class-field-shadowing error at runtime under this project's tsconfig
  // (target ES2022, useDefineForClassFields true) and aborts every render.
  declare busy: boolean;
  // The hosted versions.json catalog, null until it resolves (or forever, if
  // it 404s or fails, which is the case until a version is actually
  // published). The version dropdown only renders when this is non-null.
  declare manifest: VersionManifest | null;
  // The selected data version, defaults to the manifest's `latest` once it
  // loads. `state: true` makes assigning it re-render without reflecting an
  // attribute.
  declare version: string;
  // Seeded with the file the viewer auto-loads on open, the `url` query
  // parameter when present, else the default preset, so the URL box agrees with
  // the file the app loads on the first render.
  private urlInput = initialUrl();

  constructor() {
    super();
    this.busy = false;
    this.manifest = null;
    this.version = '';
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void fetchManifest().then((m) => {
      if (!m) return;
      this.manifest = m;
      this.version = m.latest;
    });
  }

  // The presets to offer: the current manifest version's datasets when the
  // manifest loaded and that version has any, else the built-in FILE_PRESETS.
  // This is the graceful-fallback path exercised today, since versions.json
  // is not yet published, fetchManifest always resolves null.
  private presets(): FilePreset[] {
    if (this.manifest && this.version) {
      const fromManifest = presetsForVersion(this.manifest, this.version);
      if (fromManifest.length > 0) return fromManifest;
    }
    return FILE_PRESETS;
  }

  render() {
    const presets = this.presets();
    const manifest = this.manifest;
    return html`
      <div class="load-control">
        ${manifest
          ? html`<div class="field">
              <label>Data version</label>
              <select @change=${this.onVersionChange} ?disabled=${this.busy}>
                ${manifest.versions.map(
                  (v) => html`<option value=${v.version} ?selected=${v.version === this.version}>
                    v${v.version}${v.version === manifest.latest ? ' (latest)' : ''}
                  </option>`,
                )}
              </select>
            </div>`
          : null}
        <div class="field">
          <label>File preset</label>
          <select @change=${this.onPresetChange} ?disabled=${this.busy}>
            <option value="" ?selected=${!presets.some((p) => p.url === this.urlInput)}>
              custom URL
            </option>
            ${presets.map(
              (preset) => html`<option value=${preset.url} ?selected=${preset.url === this.urlInput}>
                ${preset.label}
              </option>`,
            )}
          </select>
        </div>
        <div class="field grow">
          <label>GeoParquet URL</label>
          <input
            type="text"
            .value=${this.urlInput}
            @input=${this.onUrlInput}
            @change=${this.onUrlCommit}
            placeholder="paste a .parquet URL, then Enter"
          />
        </div>
      </div>
    `;
  }

  // Selecting a preset loads it straight away. The empty "custom URL" option
  // carries no url, so it just clears the selection without a load.
  private onPresetChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (!value) return;
    this.urlInput = value;
    this.requestUpdate();
    this.dispatchLoad();
  }

  // Switching version keeps the selected dataset when the other version has
  // it, resolved by matching preset id (see resolveVersionTwin), and loads
  // the counterpart straight away.
  private onVersionChange(event: Event) {
    const next = (event.target as HTMLSelectElement).value;
    const fromVersion = this.version;
    const manifest = this.manifest;
    this.version = next;
    if (manifest) {
      const twinUrl = resolveVersionTwin(manifest, fromVersion, next, this.urlInput);
      if (twinUrl) {
        this.urlInput = twinUrl;
        this.dispatchLoad();
      }
    }
    this.requestUpdate();
  }

  // Track the typed URL so a re-render (e.g. on busy change) keeps the field's
  // text, without loading on every keystroke.
  private onUrlInput(event: Event) {
    this.urlInput = (event.target as HTMLInputElement).value;
  }

  // The field commits on Enter or blur, which is when a typed URL loads. There
  // is no Load button, auto-loading on selection and on commit replaces it.
  private onUrlCommit() {
    this.dispatchLoad();
  }

  private dispatchLoad() {
    if (!this.urlInput) return;
    this.dispatchEvent(
      new CustomEvent<FileLoadRequest>('file-load', {
        detail: { url: this.urlInput },
        bubbles: true,
      }),
    );
  }
}

customElements.define('load-control', LoadControl);
