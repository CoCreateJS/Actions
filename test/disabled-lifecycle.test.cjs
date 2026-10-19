const assert = require('node:assert/strict');
const test = require('node:test');
const { createActions, lifecycle } = require('./helpers/actions.cjs');

async function run(names, initiallyDisabled = false, abort = true) {
    const actions = createActions();
    const button = actions.element({ actions: names.join(','), ...(initiallyDisabled ? { disabled: '' } : {}) });
    const events = lifecycle(button);
    let reachedNext = false;
    actions.init([
        { name: 'stop', callback: action => abort ? action.abort() : action.end() },
        { name: 'continue', callback: action => action.continue() },
        { name: 'next', callback: action => { reachedNext = true; action.end(); } }
    ]);
    actions.activate(button);
    await actions.flush();
    return { disabled: button.hasAttribute('disabled'),
        aborted: events.some(event => event.type === 'actionsAbort'), reachedNext };
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
    const actions = createActions();
    let ran = false;
    actions.init({ name: 'native', callback: action => { ran = true; action.end(); } });
    const click = actions.activate(actions.element({ actions: 'native' }, 'label'));
    assert.equal(click.defaultPrevented, true);
    assert.equal(ran, true);
});

test('actions can preserve native browser behavior', () => {
    const actions = createActions();
    let ran = false;
    actions.init({ name: 'native', callback: action => { ran = true; action.end(); } });
    const click = actions.activate(actions.element({ actions: 'native', 'actions-prevent-default': 'false' }, 'label'));
    assert.equal(click.defaultPrevented, false);
    assert.equal(ran, true);
});
