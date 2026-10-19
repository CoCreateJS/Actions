const assert = require('node:assert/strict');
const test = require('node:test');
const { createActions, lifecycle } = require('./helpers/actions.cjs');

test('nested actions wait for child completion before continuing', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'action(.child),next' });
    const child = actions.element({ actions: 'wait' });
    const events = lifecycle(parent);
    const calls = [];
    let childAction;
    actions.select('.child', [child]);
    actions.init([
        { name: 'wait', callback: action => { childAction = action; calls.push('child'); } },
        { name: 'next', callback: action => { calls.push('parent'); action.end(); } }
    ]);
    actions.activate(parent);
    await actions.flush();
    assert.deepEqual(calls, ['child']);
    assert.equal(events.length, 0);
    childAction.end();
    await actions.flush();
    assert.deepEqual(calls, ['child', 'parent']);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsEnd');
    assert.ok(events[0].invocationId);
});

test('action expressions use the raw attribute and preserve queryElements selectors', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'action($closest form #child)' });
    const child = actions.element({ actions: 'child' });
    const getAttribute = parent.getAttribute.bind(parent);
    parent.getAttribute = name => {
        if (name === 'actions') throw new Error('Action expressions must bypass attribute evaluation');
        return getAttribute(name);
    };
    let childCalls = 0;
    const events = lifecycle(parent);
    actions.select('$closest form #child', [child]);
    actions.init({ name: 'child', callback: action => { childCalls++; action.end(); } });
    actions.activate(parent);
    await actions.flush();
    assert.equal(childCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsEnd');
});

test('nested aborts preserve the full action path and original error', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'action(.middle)' });
    const middle = actions.element({ actions: 'action(.leaf)' });
    const leaf = actions.element({ actions: 'validate' });
    const cause = new Error('Request rejected');
    const events = lifecycle(parent);
    actions.select('.middle', [middle]);
    actions.select('.leaf', [leaf]);
    actions.init({ name: 'validate', callback: action => action.abort({
        code: 'invalid-value', message: 'Choose a value.', selector: '.field', cause
    }) });
    actions.activate(parent);
    await actions.flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsAbort');
    const { error } = events[0];
    assert.equal(error.code, 'invalid-value');
    assert.equal(error.message, 'Choose a value.');
    assert.equal(error.selector, '.field');
    assert.equal(error.cause, cause);
    assert.equal(error.element, leaf);
    assert.equal(error.action.name, 'validate');
    assert.deepEqual(Array.from(error.path, frame => frame.element), [parent, middle, leaf]);
    assert.deepEqual(Array.from(error.path, frame => frame.action.name), ['action', 'action', 'validate']);
    assert.deepEqual(Array.from(error.path, frame => frame.action.params), ['.middle', '.leaf', undefined]);
});

test('malformed abort paths are normalized into the current action frame', async t => {
    for (const path of ['invalid', { invalid: true }]) {
        await t.test(typeof path, async () => {
            const actions = createActions();
            const button = actions.element({ actions: 'validate' });
            const events = lifecycle(button);
            actions.init({ name: 'validate', callback: action => action.abort({
                message: 'Invalid value', path
            }) });
            actions.activate(button);
            await actions.flush();
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'actionsAbort');
            assert.equal(events[0].error.message, 'Invalid value');
            assert.equal(events[0].error.path.length, 1);
            assert.equal(events[0].error.path[0].element, button);
            assert.equal(events[0].error.path[0].action.name, 'validate');
        });
    }
});

test('a child abort fails the parent while a sibling keeps waiting for an event', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'disabled,action(.children),next' });
    const failed = actions.element({ actions: 'fail' });
    const waiting = actions.element({ actions: 'event(ready)' });
    const events = lifecycle(parent);
    let reachedNext = false;
    actions.select('.children', [failed, waiting]);
    actions.init([
        { name: 'fail', callback: action => action.abort('Child failed') },
        { name: 'next', callback: action => { reachedNext = true; action.end(); } }
    ]);
    actions.activate(parent);
    await actions.flush();
    assert.equal(waiting.listenerCount('ready'), 1);
    assert.equal(parent.hasAttribute('disabled'), false);
    assert.equal(reachedNext, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsAbort');
    actions.emit(waiting, 'ready');
    await actions.flush();
    assert.equal(reachedNext, false);
    assert.equal(events.length, 1);
});

test('callback exceptions and rejected promises abort the chain', async t => {
    for (const asynchronous of [false, true]) {
        await t.test(asynchronous ? 'async rejection' : 'synchronous throw', async () => {
            const actions = createActions();
            const button = actions.element({ actions: 'disabled,fail,next' });
            const events = lifecycle(button);
            const error = new Error('Callback failed');
            let reachedNext = false;
            actions.init([
                { name: 'fail', callback: () => {
                    if (asynchronous) return Promise.reject(error);
                    throw error;
                } },
                { name: 'next', callback: action => { reachedNext = true; action.end(); } }
            ]);
            actions.activate(button);
            await actions.flush();
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'actionsAbort');
            assert.equal(events[0].error.message, error.message);
            assert.equal(events[0].error.cause, error);
            assert.equal(button.hasAttribute('disabled'), false);
            assert.equal(button.listenerCount('fail'), 0);
            assert.equal(reachedNext, false);
        });
    }
});

test('callback promise fulfillment still requires explicit completion', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'wait,next' });
    let pendingAction;
    let reachedNext = false;
    actions.init([
        { name: 'wait', callback: async action => { pendingAction = action; } },
        { name: 'next', callback: action => { reachedNext = true; action.end(); } }
    ]);
    actions.activate(button);
    await actions.flush();
    assert.equal(reachedNext, false);
    pendingAction.continue();
    await actions.flush();
    assert.equal(reachedNext, true);
});

test('end, continue, and abort settle once and remove completion listeners', async t => {
    for (const firstMethod of ['end', 'continue', 'abort']) {
        await t.test(firstMethod, async () => {
            const actions = createActions();
            const button = actions.element({ actions: 'settle,next' });
            const events = lifecycle(button);
            let nextCalls = 0;
            let currentAction;
            actions.init([
                { name: 'settle', endEvent: 'settled', callback: action => {
                    currentAction = action;
                    action[firstMethod]();
                    action.end();
                    action.continue();
                    action.abort('Ignored');
                } },
                { name: 'next', callback: action => { nextCalls++; action.end(); } }
            ]);
            actions.activate(button);
            await actions.flush();
            assert.equal(button.listenerCount('settled'), 0);
            assert.equal(nextCalls, firstMethod === 'abort' ? 0 : 1);
            assert.equal(events.length, 1);
            assert.equal(events[0].type, firstMethod === 'abort' ? 'actionsAbort' : 'actionsEnd');
            actions.emit(button, currentAction.endEvent);
            await actions.flush();
            assert.equal(events.length, 1);
            assert.equal(nextCalls, firstMethod === 'abort' ? 0 : 1);
        });
    }
});

test('unrelated lifecycle events cannot complete a pending nested invocation', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'action(.child),next' });
    const child = actions.element({ actions: 'wait' });
    const events = lifecycle(parent);
    let childAction;
    let reachedNext = false;
    actions.select('.child', [child]);
    actions.init([
        { name: 'wait', callback: action => { childAction = action; } },
        { name: 'next', callback: action => { reachedNext = true; action.end(); } }
    ]);
    actions.activate(parent);
    actions.emit(child, 'actionsEnd', { invocationId: 'another-invocation' });
    actions.emit(child, 'actionsAbort', { invocationId: 'another-invocation', error: { message: 'Unrelated' } });
    await actions.flush();
    assert.equal(reachedNext, false);
    assert.equal(events.length, 0);
    childAction.end();
    await actions.flush();
    assert.equal(reachedNext, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsEnd');
});

test('action selectors can click ordinary elements without actions', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'action(.plain),next' });
    const plain = actions.element({}, 'label');
    const events = lifecycle(parent);
    let clicks = 0;
    let reachedNext = false;
    plain.addEventListener('click', () => clicks++);
    actions.select('.plain', [plain]);
    actions.init({ name: 'next', callback: action => { reachedNext = true; action.end(); } });
    actions.activate(parent);
    await actions.flush();
    assert.equal(clicks, 1);
    assert.equal(reachedNext, true);
    assert.equal(events[0].type, 'actionsEnd');
});

test('selector methods wait for promises and thenables from all targets', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'save(.fields),next' });
    const first = actions.element({}, 'input');
    const second = actions.element({}, 'input');
    let resolveFirst;
    let resolveSecond;
    let reachedNext = false;
    first.save = () => new Promise(resolve => { resolveFirst = resolve; });
    second.save = () => ({ then(resolve) { resolveSecond = resolve; } });
    actions.select('.fields', [first, second]);
    actions.init({ name: 'next', callback: action => { reachedNext = true; action.end(); } });
    actions.activate(button);
    await actions.flush();
    resolveFirst();
    await actions.flush();
    assert.equal(reachedNext, false);
    resolveSecond();
    await actions.flush();
    assert.equal(reachedNext, true);
});

test('selector method throws and rejections retain their failure details', async t => {
    for (const asynchronous of [false, true]) {
        await t.test(asynchronous ? 'async rejection' : 'synchronous throw', async () => {
            const actions = createActions();
            const button = actions.element({ actions: 'save(.field)' });
            const field = actions.element({}, 'input');
            const error = new Error('Save failed');
            const events = lifecycle(button);
            field.save = () => {
                if (asynchronous) return Promise.reject(error);
                throw error;
            };
            actions.select('.field', [field]);
            actions.activate(button);
            await actions.flush();
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'actionsAbort');
            assert.equal(events[0].error.code, 'action-method-failed');
            assert.equal(events[0].error.message, 'Save failed');
            assert.equal(events[0].error.cause, error);
            assert.equal(events[0].error.action.name, 'save');
            assert.equal(events[0].error.selector, '.field');
        });
    }
});

test('a disabled action target aborts its parent instead of waiting indefinitely', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'action(.child)' });
    const child = actions.element({ actions: 'next', disabled: '' });
    const events = lifecycle(parent);
    let ran = false;
    actions.select('.child', [child]);
    actions.init({ name: 'next', callback: action => { ran = true; action.end(); } });
    actions.activate(parent);
    await actions.flush();
    assert.equal(ran, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsAbort');
    assert.equal(events[0].error.code, 'action-not-started');
});

test('missing action selectors and unmatched selectors report useful errors', async t => {
    for (const [value, code, selector] of [
        ['action', 'missing-action-selector', undefined],
        ['action()', 'missing-action-selector', ''],
        ['action(.missing)', 'action-target-not-found', '.missing']
    ]) {
        await t.test(value, async () => {
            const actions = createActions();
            const button = actions.element({ actions: value });
            const events = lifecycle(button);
            actions.activate(button);
            await actions.flush();
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'actionsAbort');
            assert.equal(events[0].error.code, code);
            assert.equal(events[0].error.selector, selector);
            assert.equal(events[0].error.path[0].element, button);
        });
    }
});

test('error messages use setValue and clear on the next invocation', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'validate', 'aria-errormessage': ' first  second missing ' });
    const first = actions.element({ id: 'first' }, 'output');
    const second = actions.element({ id: 'second' }, 'div');
    let shouldFail = true;
    let rendered;
    second.setValue = value => { second.valueCalls.push(value); rendered = `Formatted: ${value}`; };
    actions.init({ name: 'validate', callback: action => shouldFail ? action.abort('Choose an option.') : action.end() });
    actions.activate(button);
    await actions.flush();
    for (const target of [first, second]) {
        assert.deepEqual(target.valueCalls, ['', 'Choose an option.']);
        assert.equal(target.hidden, false);
    }
    assert.equal(rendered, 'Formatted: Choose an option.');
    assert.equal(button.getAttribute('aria-invalid'), 'true');
    shouldFail = false;
    actions.activate(button);
    await actions.flush();
    for (const target of [first, second]) {
        assert.deepEqual(target.valueCalls, ['', 'Choose an option.', '']);
        assert.equal(target.hidden, true);
    }
    assert.equal(button.getAttribute('aria-invalid'), 'false');
});

test('repeated initialization runs each action only once per click', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'next' });
    let calls = 0;
    actions.init({ name: 'next', callback: action => { calls++; action.end(); } });
    actions.initialize(button);
    actions.initialize([button]);
    actions.initialize();
    actions.activate(button);
    await actions.flush();
    assert.equal(calls, 1);
    assert.equal(button.listenerCount('click'), 1);
});

test('bubbled clicks run only the closest actions element', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'parent' }, 'div');
    const child = actions.element({ actions: 'child' }, 'button', parent);
    const calls = [];
    actions.init([
        { name: 'parent', callback: action => { calls.push('parent'); action.end(); } },
        { name: 'child', callback: action => { calls.push('child'); action.end(); } }
    ]);
    actions.initialize([parent, child]);
    actions.activate(child);
    await actions.flush();
    assert.deepEqual(calls, ['child']);
});

test('clicking a descendant runs its owning actions element once', async () => {
    const actions = createActions();
    const parent = actions.element({ actions: 'parent' });
    const child = actions.element({}, 'span', parent);
    let calls = 0;
    actions.init({ name: 'parent', callback: action => { calls++; action.end(); } });
    actions.initialize(parent);
    const click = child.click();
    await actions.flush();
    assert.equal(calls, 1);
    assert.equal(click.defaultPrevented, true);
});

test('event and timeout actions wait before continuing', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'event(ready),timeout(1),next' });
    const events = lifecycle(button);
    let reachedNext = false;
    actions.init({ name: 'next', callback: action => { reachedNext = true; action.end(); } });
    actions.activate(button);
    await actions.flush();
    assert.equal(reachedNext, false);
    assert.equal(button.listenerCount('ready'), 1);
    actions.emit(button, 'ready');
    assert.equal(reachedNext, false);
    assert.equal(button.listenerCount('ready'), 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reachedNext, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'actionsEnd');
});

test('submit actions dispatch a cancelable event and wait for submitted', async t => {
    for (const canceled of [false, true]) {
        await t.test(canceled ? 'custom submission' : 'native submission', async () => {
            const actions = createActions();
            const form = actions.element({}, 'form');
            const button = actions.element({ actions: 'submit,next' }, 'button', form);
            let submissions = 0;
            let reachedNext = false;
            let submitEvent;
            form.submit = () => submissions++;
            form.addEventListener('submit', event => {
                submitEvent = event;
                if (canceled) event.preventDefault();
            });
            actions.init({ name: 'next', callback: action => { reachedNext = true; action.end(); } });
            actions.activate(button);
            await actions.flush();
            assert.equal(submissions, canceled ? 0 : 1);
            assert.equal(submitEvent.cancelable, true);
            assert.equal(submitEvent.detail.element, button);
            assert.equal(submitEvent.detail.form, form);
            assert.equal(reachedNext, false);
            actions.emit(button, 'submitted');
            await actions.flush();
            assert.equal(reachedNext, true);
            assert.equal(button.listenerCount('submitted'), 0);
        });
    }
});

test('registered aliases and custom completion events retain callback details', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'alias(.field),next' });
    const form = actions.element({}, 'form');
    button.parentElement = form;
    const events = lifecycle(button);
    let received;
    let nextCalls = 0;
    actions.init([
        { name: ['main', 'alias'], endEvent: 'customEnd', callback: action => { received = action; } },
        { name: 'next', callback: action => { nextCalls++; action.end(); } }
    ]);
    actions.activate(button);
    assert.equal(received.name, 'alias');
    assert.equal(received.params, '.field');
    assert.equal(received.endEvent, 'customEnd');
    assert.equal(received.element, button);
    assert.equal(received.form, form);
    assert.equal(nextCalls, 0);
    actions.emit(button, 'customEnd');
    await actions.flush();
    assert.equal(nextCalls, 1);
    assert.equal(events[0].type, 'actionsEnd');
    assert.equal(button.listenerCount('customEnd'), 0);
});

test('dotted methods expose their full method and use a unique completion event', async () => {
    const actions = createActions();
    const button = actions.element({ actions: 'api.records.save(.field),next' });
    const form = actions.element({}, 'form');
    button.parentElement = form;
    let received;
    let ended;
    let reachedNext = false;
    actions.init([
        { name: 'api', endEvent: 'apiEnd', callback: action => {
            received = action;
            button.addEventListener(action.endEvent, event => { ended = event.detail; }, { once: true });
        } },
        { name: 'next', callback: action => { reachedNext = true; action.end(); } }
    ]);
    actions.activate(button);
    assert.equal(received.name, 'api');
    assert.equal(received.method, 'records.save');
    assert.equal(received.params, '.field');
    assert.notEqual(received.endEvent, 'apiEnd');
    actions.emit(button, 'apiEnd');
    await actions.flush();
    assert.equal(reachedNext, false);
    received.end({ payload: 'Saved' });
    await actions.flush();
    assert.equal(reachedNext, true);
    assert.equal(ended.element, button);
    assert.equal(ended.form, form);
    assert.equal(ended.action.method, 'records.save');
    assert.equal(ended.payload, 'Saved');
    assert.equal(button.listenerCount(received.endEvent), 0);
});
