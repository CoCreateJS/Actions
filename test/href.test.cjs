const assert = require('node:assert/strict');
const test = require('node:test');
const { createActions, lifecycle } = require('./helpers/actions.cjs');

test('default navigation operates independently of a global Link component', () => {
    const actions = createActions();
    actions.globals.link = { open() { throw new Error('Legacy Link must not be consulted'); } };
    actions.api.href(actions.element({ href: '/next' }));
    assert.equal(actions.location.href, '/next');
    actions.api.href(actions.element({ href: '/another', target: '_blank' }));
    assert.deepEqual(actions.opened, [['/another', '_blank']]);
});

test('a replacement href handler runs after the chain and is awaited', async () => {
    const actions = createActions();
    const element = actions.element({ actions: 'save', href: '/next' });
    const events = lifecycle(element);
    let finishAction, finishNavigation, received;
    actions.init({ name: 'save', callback: action => { finishAction = action.end; } });
    actions.api.href = (target, context) => {
        received = { target, context };
        return new Promise(resolve => { finishNavigation = resolve; });
    };
    const click = actions.activate(element);
    assert.equal(received, undefined);
    finishAction();
    await actions.flush();
    assert.equal(received.target, element);
    assert.equal(received.context.event, click);
    assert.equal(events.length, 0);
    finishNavigation();
    await actions.flush();
    assert.equal(events[0].type, 'actionsEnd');
    assert.equal(actions.location.href, 'https://example.test/');
});
