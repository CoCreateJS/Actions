const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

class CustomEvent extends Event {
    constructor(type, options = {}) {
        super(type, options);
        this.detail = options.detail;
    }
}

function createActions() {
    const elements = [];
    const selections = new Map();
    const opened = [];
    let nextId = 0;
    const document = {
        getElementById: id => elements.find(element => element.getAttribute('id') === id),
        querySelectorAll: selector => elements.filter(element => element.matches(selector))
    };

    class Element extends EventTarget {
        constructor(attributes = {}, tagName = 'button', parentElement = null) {
            super();
            this.tagName = tagName.toUpperCase();
            this.parentElement = parentElement;
            this.values = new Map(Object.entries(attributes));
            this.attributes = { getNamedItem: name => this.hasAttribute(name) ? { value: this.values.get(name) } : null };
            this.hidden = false;
            this.valueCalls = [];
            this.clickCount = 0;
            this.listeners = [];
            elements.push(this);
        }

        getAttribute(name) { return this.values.get(name) ?? null; }
        hasAttribute(name) { return this.values.has(name); }
        setAttribute(name, value) { this.values.set(name, String(value)); }
        removeAttribute(name) { this.values.delete(name); }
        getRootNode() { return document; }
        setValue(value) { this.valueCalls.push(value); }

        matches(selector) {
            return selector.split(/,\s*/).some(part => {
                const attribute = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
                if (attribute) return this.hasAttribute(attribute[1]) &&
                    (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
                return this.tagName.toLowerCase() === part;
            });
        }

        closest(selector) {
            return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
        }

        querySelector(selector) {
            return elements.find(element => element !== this &&
                element.parentElement === this && element.matches(selector)) || null;
        }

        addEventListener(type, listener, options) {
            const capture = typeof options === 'boolean' ? options : !!options?.capture;
            if (this.listeners.some(item => item.type === type &&
                item.listener === listener && item.capture === capture)) return;
            const item = { type, listener, capture };
            item.wrapper = event => {
                if (options?.once) this.removeEventListener(type, listener, options);
                listener.call(this, event);
            };
            this.listeners.push(item);
            super.addEventListener(type, item.wrapper, options);
        }

        removeEventListener(type, listener, options) {
            const capture = typeof options === 'boolean' ? options : !!options?.capture;
            const index = this.listeners.findIndex(item => item.type === type &&
                item.listener === listener && item.capture === capture);
            if (index < 0) return;
            const [item] = this.listeners.splice(index, 1);
            super.removeEventListener(type, item.wrapper, options);
        }

        listenerCount(type) { return this.listeners.filter(item => item.type === type).length; }

        click() {
            this.clickCount++;
            if (this.tagName === 'BUTTON' && this.hasAttribute('disabled')) return;
            return dispatchClick(this);
        }
    }

    const context = vm.createContext({
        document, Element, HTMLCollection: class {}, NodeList: class {},
        Event, CustomEvent, Error, Promise, URL, setTimeout, clearTimeout,
        console: { log() {}, error() {} },
        uuid: () => `invocation-${++nextId}`,
        queryElements: ({ selector }) => selections.get(selector) || [],
        CoCreate: {}, location: { href: 'https://example.test/' },
        window: { open: (...args) => opened.push(args) }
    });
    const source = readFileSync(join(__dirname, '../../src/index.js'), 'utf8');
    const code = source.slice(source.indexOf('const attribute'), source.indexOf('Observer.init('));
    vm.runInContext(`${code}\nglobalThis.actionsTest = { init, initialize: initActions, api: CoCreateActions };`, context);

    function element(attributes, tagName, parentElement) {
        return new Element(attributes, tagName, parentElement);
    }

    function activate(target) {
        context.actionsTest.initialize(target);
        return dispatchClick(target);
    }

    return {
        api: context.actionsTest.api, globals: context.CoCreate,
        location: context.location, opened,
        element, activate, init: context.actionsTest.init,
        initialize: context.actionsTest.initialize,
        select: (selector, targets) => selections.set(selector, targets),
        emit: (target, type, detail) => target.dispatchEvent(new CustomEvent(type, { detail })),
        flush: () => new Promise(resolve => setImmediate(resolve))
    };
}

function dispatchClick(target) {
    const event = new Event('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    for (let current = target; current; current = current.parentElement) {
        current.dispatchEvent(event);
        if (event.cancelBubble) break;
    }
    return event;
}

function lifecycle(target) {
    const events = [];
    for (const type of ['actionsEnd', 'actionsAbort']) {
        target.addEventListener(type, event => events.push({ type, ...event.detail }));
    }
    return events;
}

module.exports = { createActions, lifecycle };
