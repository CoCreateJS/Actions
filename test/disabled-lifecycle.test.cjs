const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const source = readFileSync(require('node:path').join(__dirname, '../src/index.js'), 'utf8');
const code = source.slice(source.indexOf('const attribute'), source.indexOf('Observer.init('));

function dispatchActionClick(preventDefaultValue) {
    let prevented = false;
    let actionRan = false;
    const target = {
        tagName: 'LABEL',
        getAttribute(name) {
            if (name === 'actions') return 'native';
            if (name === 'actions-prevent-default') return preventDefaultValue;
            return null;
        },
        closest: () => null
    };
    const context = vm.createContext({
        event: {
            target,
            preventDefault: () => { prevented = true; }
        },
        runAction: () => { actionRan = true; },
        attribute: 'actions'
    });
    const eventFunction = source.slice(
        source.indexOf('function eventFunction('),
        source.indexOf('\nasync function runAction(')
    );
    vm.runInContext(`${eventFunction}\neventFunction(event);`, context);
    return { prevented, actionRan };
}

async function run(names, initiallyDisabled = false, abort = true) {
    const attributes = new Map(initiallyDisabled ? [['disabled', '']] : []);
    const button = new EventTarget();
    Object.assign(button, {
        closest: selector => selector === 'button' ? button : null,
        querySelector: () => null,
        hasAttribute: name => attributes.has(name),
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name)
    });
    const context = vm.createContext({
        button, names, abort, state: { aborted: false },
        CustomEvent: class extends Event { constructor(type, options) { super(type, options); this.detail = options.detail; } },
        uuid: () => 'event-id'
    });
    vm.runInContext(code + `
        let reachedNext = false;
        init([
            { name: 'stop', callback: action => abort ? action.abort() : action.end() },
            { name: 'continue', callback: action => action.continue() },
            { name: 'next', callback: action => { reachedNext = true; action.end(); } }
        ]);
        runAction(names.map(name => ({ name })), 0, button, state);
    `, context);
    await new Promise(resolve => setImmediate(resolve));
    return { disabled: attributes.has('disabled'), aborted: context.state.aborted,
        reachedNext: vm.runInContext('reachedNext', context) };
}

test('abort enables a button disabled by this chain and stops later actions', async () => {
    assert.deepEqual(await run(['disabled', 'stop', 'next']), { disabled: false, aborted: true, reachedNext: false });
});
test('abort does not toggle an already re-enabled button', async () => {
    assert.equal((await run(['disabled', 'disabled', 'stop'])).disabled, false);
});
test('abort leaves a pre-disabled button untouched without a disabled action', async () => {
    assert.equal((await run(['stop'], true)).disabled, true);
});
test('a disabled action after abort does not claim the button', async () => {
    assert.equal((await run(['stop', 'disabled'], true)).disabled, true);
});
test('successful end and continue leave the button disabled', async () => {
    assert.deepEqual(await run(['disabled', 'continue', 'stop', 'next'], false, false),
        { disabled: true, aborted: false, reachedNext: true });
});
test('an explicit second disabled action enables the button on success', async () => {
    assert.equal((await run(['disabled', 'stop', 'disabled'], false, false)).disabled, false);
});

test('actions prevent native browser behavior by default', () => {
    assert.deepEqual(dispatchActionClick(null), { prevented: true, actionRan: true });
});

test('actions can preserve native browser behavior', () => {
    assert.deepEqual(dispatchActionClick('false'), { prevented: false, actionRan: true });
});
