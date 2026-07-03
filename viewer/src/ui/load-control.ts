import { LitElement, html } from 'lit';
import { FILE_PRESETS, initialUrl } from '../data/presets';

export interface FileLoadRequest {
  url: string;
}

export class LoadControl extends LitElement {
  static properties = {
    busy: { type: Boolean },
  };

  // `declare` erases this field at compile time so TypeScript's ES2022
  // class-field emit does not shadow the reactive accessor Lit installs on
  // the prototype for properties named in `static properties`. Initializing
  // `busy = false` as a normal class field here throws Lit's
  // class-field-shadowing error at runtime under this project's tsconfig
  // (target ES2022, useDefineForClassFields true) and aborts every render.
  declare busy: boolean;
  // Seeded with the file the viewer auto-loads on open, the `url` query
  // parameter when present, else the default preset, so the URL box agrees with
  // the file the app loads on the first render.
  private urlInput = initialUrl();

  constructor() {
    super();
    this.busy = false;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="load-control">
        <div class="field">
          <label>File preset</label>
          <select @change=${this.onPresetChange} ?disabled=${this.busy}>
            <option value="" ?selected=${!FILE_PRESETS.some((p) => p.url === this.urlInput)}>
              custom URL
            </option>
            ${FILE_PRESETS.map(
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
