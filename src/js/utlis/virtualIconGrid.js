/*
  Virtualized Icon Grid (vanilla JS)
  ----------------------------------
  Renders only the visible icons (plus a buffer) inside a scrollable container.
  - No frameworks, no dependencies
  - Works with your availableIcons: [{ value: string, categories?: string[] }]
  - Integrates with an <input> for searching
  - Keeps DOM size tiny and fast even with thousands of icons

  Basic usage (inside your component/class):

    this.virtualIconGrid = new VirtualIconGrid({
      container: root.content,                    // scrollable container element
      items: this.availableIcons,                 // data source
      renderItem: (icon) => {
        // Customize how each icon renders
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `icon-element ${icon.value}`; // keep your class for styles
        btn.title = icon.value;
        btn.setAttribute('aria-label', icon.value);
        // Example inner content; adjust to your icon system
        btn.innerHTML = `<i class="${icon.value}"></i>`;
        // Optional: selection behavior
        btn.addEventListener('click', () => this._onSelect && this._onSelect(icon));
        return btn;
      },
      i18nEmpty: options.i18n['text:empty'],
      estimateItemSize: { width: 72, height: 72 }, // tune to your icon tile size
      bufferRows: 4                                // extra rows rendered above/below viewport
    });

    this.virtualIconGrid.mount();

    // Hook up search input
    const onSearch = debounce((evt) => {
      const q = (evt.target.value || '').trim().toLowerCase();
      this.virtualIconGrid.setQuery(q);
    }, 120);
    this._eventBindings.push(addEvent(root.search, 'input', onSearch));

  Minimal CSS you should have:
    .virtual-scroll { overflow: auto; position: relative; }
    .vs-inner { position: relative; width: 100%; }
    .vs-item { position: absolute; }
    .is-empty { padding: 1rem; color: #666; }

*/

export default class VirtualIconGrid {
  constructor({
    container,
    items,
    renderItem,
    i18nEmpty = 'No results',
    estimateItemSize = { width: 42, height: 42 },
    gaps = { x: 6, y: 6 },

    bufferRows = 3
  }) {
    if (!container) throw new Error('VirtualIconGrid: container is required');
    if (!renderItem) throw new Error('VirtualIconGrid: renderItem is required');

    this.container = container; // scrollable element
    this.items = Array.isArray(items) ? items.slice() : [];
    this.renderItem = renderItem;
    this.i18nEmpty = i18nEmpty;
    this.estimate = estimateItemSize;
    this.bufferRows = Math.max(0, bufferRows | 0);

    // Internal state
    this._query = '';
    this._indexed = [];   // [{value, text}]
    this._filtered = [];  // filtered items
    this._cols = 1;
    this._itemW = this.estimate.width;
    this._itemH = this.estimate.height;
    this._gapX = gaps.x; // horizontal gap guess; refined via measurement
    this._gapY = gaps.y; // vertical gap guess
    this._mounted = false;
    this._onScroll = this._onScroll.bind(this);
    this._onResize = this._onResize.bind(this);

    // DOM nodes
    this._inner = document.createElement('div');
    this._inner.className = 'vs-inner';
    this._emptyEl = document.createElement('div');
    this._emptyEl.className = 'is-empty';
    this._emptyEl.textContent = this.i18nEmpty;

    // For cheap diff to avoid rerendering same window
    this._lastRange = { start: -1, end: -1 };

    // Observer
    this._resizeObs = null;

    // Prepare index and initial filter
    this._buildIndex();
    this._filtered = this.items;
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;

    // Clear container (you may want to preserve other siblings if needed)
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);

    // Ensure container has the right class for scroll behavior
    this.container.classList.add('virtual-scroll');

    // Attach inner scroll space
    this.container.appendChild(this._inner);

    // Measure actual item size + gaps using a sample
    this._measureItem();

    // Compute columns and paint initial frame
    this._computeLayout();
    this._updateInnerHeight();
    this._renderWindow();
    this._toggleEmptyMessage();

    // Listeners
    this.container.addEventListener('scroll', this._onScroll, { passive: true });

    // ResizeObserver for container size changes
    if ('ResizeObserver' in window) {
      this._resizeObs = new ResizeObserver(this._onResize);
      this._resizeObs.observe(this.container);
    } else {
      // Fallback: recompute on window resize
      window.addEventListener('resize', this._onResize);
    }
  }

  destroy() {
    if (!this._mounted) return;
    this._mounted = false;

    this.container.removeEventListener('scroll', this._onScroll);
    if (this._resizeObs) {
      this._resizeObs.disconnect();
      this._resizeObs = null;
    } else {
      window.removeEventListener('resize', this._onResize);
    }

    // Clean DOM
    this._inner.replaceChildren();
    if (this._emptyEl && this._emptyEl.parentNode) this._emptyEl.remove();
  }

  setItems(nextItems) {
    this.items = Array.isArray(nextItems) ? nextItems.slice() : [];
    this._buildIndex();
    this._applyFilter();
  }

  setQuery(q) {
    const next = (q || '').toLowerCase();
    if (next === this._query) return;
    this._query = next;
    this._applyFilter();
  }

  // ---------- internals ----------
  _buildIndex() {
    this._indexed = this.items.map(it => ({
      value: it.value,
      text: [it.value, ...(it.categories || [])].join(' ').toLowerCase(),
      ref: it
    }));
  }

  _applyFilter() {
    if (!this._query) {
      this._filtered = this.items;
    } else {
      const q = this._query;
      this._filtered = this._indexed
        .filter(row => row.text.includes(q))
        .map(row => row.ref);
    }

    this._toggleEmptyMessage();
    this._updateInnerHeight();
    this._lastRange.start = -1; // force repaint
    this._renderWindow();
  }

  _toggleEmptyMessage() {
    const hasResults = this._filtered.length > 0;
    if (!hasResults) {
      if (!this._emptyEl.parentNode) this.container.appendChild(this._emptyEl);
    } else if (this._emptyEl.parentNode) {
      this._emptyEl.remove();
    }
  }

  _measureItem() {
    // Create a sample tile using renderItem to get actual size and margins/gaps
    const sampleData = this.items[0] || { value: 'sample' };
    const sample = this.renderItem(sampleData);
    sample.style.position = 'absolute';
    sample.style.visibility = 'hidden';
    sample.classList.add('vs-item');

  // Ignore measured size, always use configured estimateItemSize for robust layout
  this._itemW = this.estimate.width;
  this._itemH = this.estimate.height;
  sample.remove();
  }

  _computeLayout() {
    const width = this.container.clientWidth || 1;
    const fullW = this._itemW + this._gapX;
    const cols = Math.max(1, Math.floor((width + this._gapX) / fullW));

    this._cols = cols;
  }

  _totalRows() {
    return Math.ceil(this._filtered.length / this._cols);
  }

  _updateInnerHeight() {
    const rows = this._totalRows();
    const totalH = rows * (this._itemH + this._gapY) - this._gapY; // last row no gap
    this._inner.style.height = Math.max(0, totalH).toString() + 'px';
    const scrollBarWidth = this._inner.parentElement.offsetWidth - this._inner.parentElement.clientWidth
    this._inner.parentElement.style.width = Math.max(this._cols * (this._itemW + this._gapX) - this._gapX + scrollBarWidth) + 'px';
  }

  _onResize() {
    const prevCols = this._cols;
    this._computeLayout();
    if (this._cols !== prevCols) {
      this._updateInnerHeight();
      this._lastRange.start = -1; // force repaint on layout change
      this._renderWindow();
    } else {
      // Height may still change if container height changed
      this._renderWindow();
    }
  }

  _onScroll() {
    this._renderWindow();
  }

  _renderWindow() {
    if (!this._filtered.length) {
      this._inner.replaceChildren();
      this._lastRange = { start: -1, end: -1 };
      return;
    }

    const viewTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    const rowH = this._itemH + this._gapY;

    const firstRow = Math.max(0, Math.floor(viewTop / rowH) - this.bufferRows);
    const lastRow = Math.floor((viewTop + viewH) / rowH) + this.bufferRows;

    const start = firstRow * this._cols;
    const endExclusive = Math.min(this._filtered.length, (lastRow + 1) * this._cols);

    if (start === this._lastRange.start && endExclusive === this._lastRange.end) return;
    this._lastRange = { start, end: endExclusive };

    const frag = document.createDocumentFragment();

    for (let i = start; i < endExclusive; i++) {
      const data = this._filtered[i];
      if (!data) continue;
      const row = Math.floor(i / this._cols);
      const col = i % this._cols;
      const x = col * (this._itemW + this._gapX);
      const y = row * (this._itemH + this._gapY);

      const el = this.renderItem(data);
      el.classList.add('vs-item');
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.width = this._itemW + 'px';
      el.style.height = this._itemH + 'px';
  
      frag.appendChild(el);
    }

    this._inner.replaceChildren(frag);
  }
}
