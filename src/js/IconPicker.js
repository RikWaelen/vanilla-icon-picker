import * as _ from "./utlis/utils";
import VirtualIconGrid from "./utlis/virtualIconGrid";
import template from "./template";
import { resolveCollection } from "./utlis/collections";

export default class IconPicker {
    virtualIconGrid = null;
    availableIcons = [];
    static DEFAULT_OPTIONS = {
        theme: 'default',
        closeOnSelect: true,
        defaultValue: null,
        iconSource: [],
        i18n: {
            'input:placeholder': 'Search icon…',

            'text:title': 'Select icon',
            'text:empty': 'No results found…',
            'text:loading' : 'Loading…',

            'btn:save': 'Save'
        }
    }

    _eventListener = {
        select: [],
        save: [],
        show: [],
        clear: [],
        hide: [],
        loaded: []
    };

    /**
     *
     * @param {string | HTMLElement} el
     * @param {Object} options
     */
    constructor(el, options = {}) {
        this.options = _.mergeDeep(IconPicker.DEFAULT_OPTIONS, options);
        this.element = el;
        this.iconsLoading = true;

        // Initialize icon picker
        this._preBuild();

        if (this.element && this.options.iconSource.length > 0) {
            this._binEvents();
            this._renderdIcons();
            this._createModal();
        } else {
            this._catchError('iconSourceMissing');
        }

    }

    _preBuild() {
        this.element = _.resolveElement(this.element);
        this.root = template(this.options);

        if (!Array.isArray(this.options.iconSource) && this.options.iconSource.length > 0) {
            this.options.iconSource = [this.options.iconSource];
        }
        // Prepare (lazy) virtual grid; mount after modal becomes visible to get correct widths
        this.virtualIconGrid = this.virtualIconGrid || new VirtualIconGrid({
            container: this.root.content,
            items: this.availableIcons ?? [],
            renderItem: (icon) => this.renderItem(icon),
            i18nEmpty: this.options.i18n['text:empty'],
            estimateItemSize: { width: 34, height: 34 }, // tweak to your tile size
            bufferRows: 4
        });
    }

    renderItem(icon) {
        // Customize how each icon renders
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `icon-element ${icon.value}`; // keep your class for styles
        btn.title = icon.value;
        btn.setAttribute('aria-label', icon.value);
        // Example inner content; adjust to your icon system
        btn.innerHTML = icon.body;
        // Selection behavior
        btn.addEventListener('click', (evt) => icon.onSelect && icon.onSelect(evt));
        
        return btn;
    }


    ensureVirtualMounted = () => {
        // If modal just opened, wait a frame so it has layout/width
        requestAnimationFrame(() => {
        if (!this.virtualIconGrid._mounted) {
            this.virtualIconGrid.mount();
        } else {
            // Recompute columns/height if container size changed while hidden
            this.virtualIconGrid._onResize && this.virtualIconGrid._onResize();
        }
        // Apply whatever is currently in the search box
        const q = (this.root.search?.value || '').trim().toLowerCase();
        this.virtualIconGrid.setQuery(q);
        this.virtualIconGrid.setItems(this.availableIcons);
        });
    };


    _binEvents() {
        const {options, root, element, virtualIconGrid} = this;

        const onSearch = _.debounce((evt) => {
            const q = (evt.target.value || '').trim().toLowerCase();
            if (virtualIconGrid) virtualIconGrid.setQuery(q);
        }, 120);

        this._eventBindings = [
            _.addEvent(element, 'click', () => { 
                this.show(); 
                this.ensureVirtualMounted(); 
            }),
            _.addEvent(root.close, 'click', () => this.hide()),
            _.addEvent(root.modal, 'click', (evt) => {
                if (evt.target === root.modal) {
                    this.hide();
                }
            }),
            _.addEvent(root.search, 'keyup', _.debounce(onSearch, 250))
        ];

        if (!options.closeOnSelect) {
            this._eventBindings.push(_.addEvent(root.save, 'click', () => this._onSave()));
        }
    }

    /**
     * Hide icon picker modal
     */
    hide() {
        if (this.isOpen()) {
            this.root.modal.classList.remove('is-visible');
            this._emit('hide');

            return this;
        }

        return false
    }

    /**
     * Show icon picker modal
     */
    show() {
        if (!this.isOpen()) {
            this.root.modal.classList.add('is-visible');
            this._emit('show');

            return this;
        }

        return false
    }

    clear() {
        if (this.initialized && this.currentlySelectName) {
            this.currentlySelectName = null;

            this._emit('clear');
        }
    }

    /**
     * Check if modal is open
     * @returns {boolean}
     */
    isOpen() {
        return this.root.modal.classList.contains('is-visible');
    }

    /**
     * Check if the icons are loaded
     * @returns {boolean}
     */
    iconsLoaded(){
        return !this.loadingState;
    }

    /**
     * Destroy icon picker instance and detach all events listeners
     * @param {boolean} deleteInstance
     */
    destroy(deleteInstance = true) {
        this.initialized = false;

        // Remove elements events
        this._eventBindings.forEach(args => _.removeEvent(...args));

        // Delete instance
        if (deleteInstance) {
            Object.keys(this).forEach((key) => delete this[key]);
        }
    }

    _emit(event, ...args) {
        this._eventListener[event].forEach(cb => cb(...args, this));
    }

    on(event, callback) {
        if (this._eventListener[event] !== undefined) {
            this._eventListener[event].push(callback);
            return this;
        }

        return false
    }

    off(event, callback) {
        const callBacks = (this._eventListener[event] || []);
        const index = callBacks.indexOf(callback);

        if (~index) {
            callBacks.splice(index, 1);
        }

        return this;
    }

    _createModal() {
        document.body.appendChild(this.root.modal);

        this.initialized = true;
    }

    _onSave() {
        this._setValueInput()

        this.hide();
        this._emit('save', this.emitValues);
    }

    /**
     * Generate icons elements
     * @private
     */
    async _renderdIcons() {
        const {root, options} = this;
        let previousSelectedIcon = null;
        let currentlySelectElement = null;
        let categories = null;
        this.availableIcons = [];

        root.content.innerHTML = `<div class="is-loading">${options.i18n['text:loading']}</div>`;

        let icons = await this._getIcons();

        icons.forEach((library) => {
            let iconFormat = library.iconFormat ? library.iconFormat : 'svg';

            for (const [key, value] of Object.entries(library.icons)) {
                const iconTarget = document.createElement('button');
                iconTarget.title = key
                iconTarget.className = `icon-element ${key}`;
                iconTarget.dataset.value = library.prefix + key;

                if (library.categories && Object.entries(library.categories).length > 0) {
                    categories = [];

                    for (const [categoryKey] of Object.entries(library.categories)) {
                        if (library.categories[categoryKey].includes(key)) {
                            if (categories.length > 0) {
                                categories.push(categoryKey.toLowerCase())
                            } else {
                                categories = [categoryKey.toLowerCase()]
                            }
                        }
                    }
                }

                if (library.chars) {
                    iconTarget.dataset.unicode = _.getKeyByValue(library.chars, key);
                }

                let iconElement;
                if (iconFormat === 'i' || !value.body) {
                    iconElement = document.createElement('i');
                    iconElement.setAttribute('class', iconTarget.dataset.value);
                } else if (iconFormat === 'markup') {
                    let t = document.createElement('template');
                    t.innerHTML = value.body;
                    iconElement = t.content;
                } else {
                    iconElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    iconElement.setAttribute('height', '24');
                    iconElement.setAttribute('width', '24');
                    iconElement.setAttribute('viewBox', `0 0 ${value.width ? value.width : library.width} ${value.height ? value.height : library.height}`);
                    iconElement.innerHTML = value.body;
                }

                this.availableIcons.push({value: key, body: iconElement.outerHTML, ...(categories?.length > 0 && {categories}), onSelect: (evt) => {
                    if (this.currentlySelectName !== evt.currentTarget.firstChild.className) {
                        evt.currentTarget.classList.add('is-selected');

                        currentlySelectElement = evt.currentTarget;
                        this.currentlySelectName = currentlySelectElement.dataset.value;
                        this.SVGString = iconElement.outerHTML;

                        this.emitValues = {
                            name: key,
                            value: this.currentlySelectName,
                            svg: this.SVGString,
                        }

                        if (library.chars) {
                            this.emitValues.unicode = iconElement.dataset.unicode
                        }

                        this._emit('select', this.emitValues);
                    }

                    if (previousSelectedIcon) {
                        previousSelectedIcon.classList.remove('is-selected');
                    }

                    if (options.closeOnSelect) {
                        this._onSave();
                    }

                    previousSelectedIcon = currentlySelectElement;
                }});
            }
        });

        if (options.defaultValue || this.element.value) {
            // Check if icon name ou icon value is set
            let defaultValueElement = document.querySelector(`[data-value="${options.defaultValue ? options.defaultValue : this.element.value}"]`) ?
                document.querySelector(`[data-value="${options.defaultValue ? options.defaultValue : this.element.value}"]`) :
                document.querySelector(`.${options.defaultValue ? options.defaultValue : this.element.value}`);

            let iconValue = defaultValueElement?.dataset.value ?? '';
            defaultValueElement?.classList.add('is-selected');

            previousSelectedIcon = defaultValueElement;
            this.currentlySelectName = iconValue;

            if (!this.element.value) {
                this._setValueInput();
            }
        }

        const loadingElement = root.content.querySelector('.is-loading');
        if (loadingElement) {
            loadingElement.remove();
        }

        this.iconsLoading = false;
        this._emit('loaded');
    }

    /**
     *
     * @returns {string}
     * @private
     */
    async _getIcons() {
        const {options} = this
        const iconsURL = [];

        let sourceInformation = resolveCollection(options.iconSource);

        for (const source of Object.values(sourceInformation)) {
            iconsURL.push(source.url)
        }

        return await Promise.all(iconsURL.map((iconURL) => fetch(iconURL).then((response) => response.json())))
            .then((iconLibrary) => {
                iconLibrary.forEach((library) => {
                    if (sourceInformation.hasOwnProperty(library.prefix)) {
                        library.prefix = sourceInformation[library.prefix].prefix
                    }
                });

                return iconLibrary;
            });
    }

    /**
     *
     * @param {string} exception
     * @private
     */
    _catchError(exception) {
        switch (exception) {
            case 'iconSourceMissing':
                throw Error('No icon source was found.');
        }
    }

    /**
     * Set value into input element
     * @param value
     * @private
     */
    _setValueInput(value = this.currentlySelectName) {
        const {element} = this;

        if (element instanceof HTMLInputElement && this.currentlySelectName) {
            element.value = value;
        }
    }
}
