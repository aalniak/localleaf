import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { h, debounce } from '../dom.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const PAGE_GAP = 12;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

/**
 * Continuous-scroll PDF viewer. Pages are laid out at their final size up front
 * and rendered lazily as they approach the viewport, so large documents with
 * many images stay responsive. Double-clicking a page reports PDF coordinates
 * (points from the top-left) for SyncTeX.
 */
export class PdfViewer {
  constructor(container, { onSyncClick, onZoomChange } = {}) {
    this.onSyncClick = onSyncClick;
    this.onZoomChange = onZoomChange;
    this.zoom = 'fit';
    this.scale = 1;
    this.doc = null;
    this.pages = [];
    this.loadToken = 0;
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.scroller = h('div', { class: 'pdf-scroller' }, this.pagesEl);
    this.messageEl = h('div', { class: 'pdf-message' });
    container.append(this.scroller, this.messageEl);
    this.observer = new IntersectionObserver((items) => this.#onVisible(items), { root: this.scroller, rootMargin: '800px 0px' });
    const refit = debounce(() => this.zoom === 'fit' && this.doc && this.#relayout(), 150);
    new ResizeObserver(refit).observe(this.scroller);
  }

  showMessage(text) {
    this.messageEl.textContent = text ?? '';
    this.messageEl.hidden = !text;
  }

  /** Load (or reload) a PDF, keeping the reader's position across recompiles. */
  async load(url) {
    const token = ++this.loadToken;
    const doc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
    if (token !== this.loadToken) {
      doc.destroy();
      return;
    }
    const sizes = await Promise.all(
      Array.from({ length: doc.numPages }, async (_, i) => {
        const page = await doc.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        return { page, width: vp.width, height: vp.height };
      }),
    );
    if (token !== this.loadToken) {
      doc.destroy();
      return;
    }
    const anchor = this.#scrollAnchor();
    const old = this.doc;
    this.doc = doc;
    this.pages = sizes.map((s, i) => ({ ...s, number: i + 1, el: null, canvas: null, task: null, renderedScale: 0 }));
    this.#buildPages();
    this.#restoreAnchor(anchor);
    this.showMessage('');
    old?.destroy();
  }

  clear(message) {
    this.loadToken += 1;
    this.doc?.destroy();
    this.doc = null;
    this.pages = [];
    this.pagesEl.replaceChildren();
    this.showMessage(message);
  }

  setZoom(zoom) {
    this.zoom = zoom === 'fit' ? 'fit' : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (this.doc) {
      const anchor = this.#scrollAnchor();
      this.#relayout();
      this.#restoreAnchor(anchor);
    }
  }

  zoomBy(factor) {
    this.setZoom(this.scale * factor);
  }

  #fitScale() {
    const widest = Math.max(...this.pages.map((p) => p.width), 1);
    return Math.max(MIN_ZOOM, (this.scroller.clientWidth - 2 * PAGE_GAP - 4) / widest);
  }

  #relayout() {
    this.scale = this.zoom === 'fit' ? this.#fitScale() : this.zoom;
    for (const p of this.pages) {
      if (!p.el) continue;
      p.el.style.width = `${Math.floor(p.width * this.scale)}px`;
      p.el.style.height = `${Math.floor(p.height * this.scale)}px`;
    }
    this.onZoomChange?.(this.scale, this.zoom);
    this.#renderVisible();
  }

  #buildPages() {
    this.observer.disconnect();
    this.scale = this.zoom === 'fit' ? this.#fitScale() : this.zoom;
    const els = this.pages.map((p) => {
      const el = h('div', { class: 'pdf-page', dataset: { page: String(p.number) } });
      el.style.width = `${Math.floor(p.width * this.scale)}px`;
      el.style.height = `${Math.floor(p.height * this.scale)}px`;
      el.addEventListener('dblclick', (e) => this.#handleDoubleClick(p, e));
      p.el = el;
      this.observer.observe(el);
      return el;
    });
    this.pagesEl.replaceChildren(...els);
    this.onZoomChange?.(this.scale, this.zoom);
  }

  #onVisible(items) {
    for (const item of items) {
      const p = this.pages[Number(item.target.dataset.page) - 1];
      if (!p) continue;
      p.visible = item.isIntersecting;
      if (item.isIntersecting) this.#render(p);
    }
  }

  #renderVisible() {
    for (const p of this.pages) if (p.visible) this.#render(p);
  }

  async #render(p) {
    const dpr = window.devicePixelRatio || 1;
    const target = this.scale * dpr;
    if (p.renderedScale === target || !p.el) return;
    p.task?.cancel();
    const viewport = p.page.getViewport({ scale: target });
    const canvas = h('canvas', { class: 'pdf-canvas' });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    p.renderedScale = target;
    p.task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport });
    try {
      await p.task.promise;
      p.canvas?.remove();
      p.canvas = canvas;
      p.el.prepend(canvas);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error('PDF render failed', err);
      if (p.renderedScale === target) p.renderedScale = 0;
    }
  }

  #handleDoubleClick(p, event) {
    const rect = p.el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / this.scale;
    const y = (event.clientY - rect.top) / this.scale;
    this.onSyncClick?.({ page: p.number, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }

  /** Scroll to and flash a SyncTeX box: { page, h, v, width, height } in PDF points. */
  highlight(box) {
    const p = this.pages[box.page - 1];
    if (!p?.el) return;
    const top = Math.max(0, (box.v - box.height) * this.scale);
    const marker = h('div', { class: 'sync-highlight' });
    Object.assign(marker.style, {
      left: `${box.h * this.scale}px`,
      top: `${top}px`,
      width: `${Math.max(box.width, 20) * this.scale}px`,
      height: `${Math.max(box.height, 8) * this.scale}px`,
    });
    p.el.append(marker);
    setTimeout(() => marker.remove(), 2200);
    this.scroller.scrollTo({ top: p.el.offsetTop + top - this.scroller.clientHeight / 3, behavior: 'smooth' });
  }

  #scrollAnchor() {
    if (!this.pages.length) return null;
    const top = this.scroller.scrollTop;
    const p = this.pages.find((pg) => pg.el && pg.el.offsetTop + pg.el.offsetHeight > top) ?? this.pages[0];
    if (!p.el) return null;
    return { page: p.number, ratio: (top - p.el.offsetTop) / p.el.offsetHeight, left: this.scroller.scrollLeft };
  }

  #restoreAnchor(anchor) {
    if (!anchor) return;
    const p = this.pages[Math.min(anchor.page, this.pages.length) - 1];
    if (!p?.el) return;
    this.scroller.scrollTop = p.el.offsetTop + anchor.ratio * p.el.offsetHeight;
    this.scroller.scrollLeft = anchor.left;
  }
}
