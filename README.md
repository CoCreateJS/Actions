# @cocreate/actions

A sequential execution pipeline for the browser, configured entirely through HTML5 attributes. A single `actions` attribute chains any number of component executions together: each action runs, signals completion, and only then does the next one begin. Actions are contributed by every CoCreate module, so saving a record, calling a third-party API, rendering a template, waiting on an event, and following a link compose into one declarative sequence without writing JavaScript.

---

## Documentation

For a complete guide and working demo refer to the [documentation](https://cocreate.app/docs/actions).

## Table of Contents

* [Features](#features)
* [Installation](#installation)
* [Usage](#usage)
* [How it Works](#how-it-works)
* [Anatomy of an Action Chain](#anatomy-of-an-action-chain)
* [Sequencing and Completion](#sequencing-and-completion)
* [Control Actions](#control-actions)
* [Element Method Actions](#element-method-actions)
* [Registered Actions](#registered-actions)
* [Targeting Elements](#targeting-elements)
* [JavaScript API](#javascript-api)
* [Behavior Notes](#behavior-notes)
* [Announcements](#announcements)
* [Roadmap](#roadmap)
* [How to Contribute](#how-to-contribute)
* [About](#about)
* [License](#license)

---

## Features

* **Declarative Sequencing:** Chain any number of executions in a single attribute, running strictly in order.
* **Asynchronous Awareness:** Each action signals its own completion, so database writes, network requests, and renders finish before the next step starts.
* **Universal Registration:** Any module can contribute an action by name, making its behavior available to markup across the entire application.
* **Element Method Invocation:** Call methods directly on queried elements, awaiting any promises they return.
* **Flow Control:** Wait for events, delay execution, trigger other chains, submit forms, and toggle button state as first-class steps.
* **Abort Semantics:** An action can halt the remainder of the chain when a step fails or a condition is not met.
* **Relational Targeting:** Action parameters accept the full CoCreate selector grammar, including `$parent`, `$next`, `$closest`, and `$document`.
* **Automatic Binding:** Elements added to the DOM later are bound automatically, so rendered templates behave like static markup.

---

## Installation

```bash
npm install @cocreate/actions
```

```bash
yarn add @cocreate/actions
```

### CDN

```html
<script src="https://cdn.cocreate.app/actions/latest/CoCreate-actions.min.js"></script>
```

---

## Usage

### Chain Executions

Actions run left to right. Each one waits for the previous to complete.

```html
<button actions="save, reset">Save</button>
```

### Pass Parameters

A parameter is supplied in parentheses and is usually a selector.

```html
<button actions="save, action($document #refresh-list)">Save</button>
```

### Chain Across Modules

Because every module registers its actions by name, a single chain can persist a record, call an API, and update the interface.

```html
<button actions="save, stripe.customers.create, render, reset">
	Create customer
</button>
```

### Delay and Wait

```html
<button actions="save, timeout(1000), action($document #notify)">Save</button>
```

---

## How it Works

1. A click listener is bound to every `[actions]` element, including elements inserted later.
2. When triggered, the attribute is split on commas into an ordered list of staged actions.
3. Each entry is parsed into a name and optional parenthesized parameters. A name containing a dot is split into an action name and a method, so `stripe.customers.create` invokes the `stripe` action with the method `customers.create`.
4. The first action runs. The pipeline attaches a one-time listener for that action's completion event before invoking it.
5. When the completion event fires, the next action starts. This repeats until the chain is exhausted or aborted.
6. Once every action has completed, the pipeline performs a native form submission if a real form action is present, then follows any link on the element.

---

## Anatomy of an Action Chain

```html
<button actions="save, timeout(500), stripe.customers.create">Go</button>
```

| Part | Meaning |
| ---- | ------- |
| `save` | A registered action, resolved by name |
| `,` | Sequential separator, the next action waits for the previous |
| `timeout(500)` | An action with a parameter |
| `stripe.customers.create` | Action `stripe` invoked with method `customers.create` |

---

## Sequencing and Completion

An action is considered finished when its **completion event** fires on the element. Registration declares that event, and it defaults to the action's own name.

```javascript
Actions.init({
	name: "save",
	endEvent: "saved",
	callback: (action) => { /* … */ }
});
```

The callback receives everything needed to do its work and to report back:

| Property | Description |
| -------- | ----------- |
| `element` | The element carrying the `actions` attribute |
| `form` | The closest ancestor form, when present |
| `name` | Resolved action name |
| `method` | Method portion of a dotted action name |
| `params` | Parameter string, when supplied |
| `endEvent` | Completion event the pipeline is listening for |
| `end(detail)` | Dispatches the completion event, advancing the chain |
| `continue()` | Advances the chain directly |
| `abort()` | Halts the chain, skipping all remaining actions |

An action that neither dispatches its completion event nor calls `continue()` or `abort()` leaves the chain waiting, which is the intended behavior for steps that resolve later.

Actions written with a dotted name receive a unique completion event per run, so concurrent chains using the same provider never resolve one another.

---

## Control Actions

These are always available and require no registration.

| Action | Parameter | Behavior |
| ------ | --------- | -------- |
| `timeout(ms)` | milliseconds | Pauses the chain for the given duration |
| `event(name)` | event name | Waits for that event to fire on the element |
| `action(selector)` | selector | Clicks the matching elements, triggering their own chains |
| `submit` | none | Dispatches a cancelable submit on the closest form and waits for a `submitted` event |
| `disabled` | none | Toggles the `disabled` attribute on the closest button |

```html
<button actions="disabled, save, disabled">Save</button>
```

```html
<button actions="save, event(uploaded), render">Save and wait for upload</button>
```

---

## Element Method Actions

When a name is not registered and is not a control action, the pipeline treats it as a **method call on the queried elements**. Every match that exposes a function of that name has it invoked, and any returned promises are awaited before the chain continues.

```html
<button actions="read($document #profile)">Reload profile</button>
```

This calls `read()` on `#profile`. The same mechanism covers `renderValue`, `getValue`, and any method a module adds to an element, which makes the pipeline extensible without registering anything.

> A method action requires a parameter to select its targets. `submit` and `disabled` are the only control actions that operate without one.

---

## Registered Actions

Modules register their actions on import. Commonly available names include:

| Action | Completion Event | Provided By |
| ------ | ---------------- | ----------- |
| `save` | `saved` | `@cocreate/elements` |
| `delete` | `deleted` | `@cocreate/elements` |
| `reset` | `reset` | `@cocreate/elements` |
| `render` | `render` | `@cocreate/render` |
| `click`, `toggle`, `hover`, `input`, `change`, `focus`, `blur`, and every other event prefix | `<name>End` | `@cocreate/events` |
| Any provider declared with `api="name"` | per run | `@cocreate/api` |

Because event prefixes are registered as actions, a binding can be invoked as a step rather than by user interaction:

```html
<button actions="save, click($document #panel)">Save and open panel</button>
```

---

## Targeting Elements

Parameters accept standard CSS selectors plus the CoCreate relational operators, and a trailing `[]` selects every match rather than the first.

| Operator | Resolves To |
| -------- | ----------- |
| `$document` | The owning document |
| `$parent` | The parent element |
| `$next` | The next element sibling |
| `$previous` | The previous element sibling |
| `$closest <selector>` | Nearest matching ancestor |
| `$frame` | The frame element of the current document |
| `$top` | The top-level document |

```html
<button actions="save, action($closest .card .refresh[])">Save</button>
```

---

## JavaScript API

### Register an Action

```javascript
import Actions from "@cocreate/actions";

Actions.init({
	name: "notify",
	endEvent: "notified",
	callback: async (action) => {
		await sendNotification(action.params);
		action.end();
	}
});
```

### Register Several at Once

`init()` accepts an array, and `name` may itself be an array of aliases.

```javascript
Actions.init([
	{ name: ["publish", "release"], endEvent: "published", callback: publish },
	{ name: "archive", endEvent: "archived", callback: archive }
]);
```

Registration is idempotent: a name that is already registered is left untouched, so the first module to claim a name owns it.

### Abort a Chain

```javascript
Actions.init({
	name: "validate",
	callback: (action) => {
		if (!action.form.checkValidity()) return action.abort();
		action.end();
	}
});
```

```html
<button actions="validate, save, reset">Submit</button>
```

---

## Behavior Notes

* Chains are triggered by `click`. Elements without a native click target can still be driven from another chain using `action(selector)`.
* The pipeline resolves the nearest `[actions]` ancestor, so icons and spans inside a button trigger the button's chain.
* Default click behavior is prevented while a chain runs. A form whose `action` is a real URL submits natively instead.
* After the final action, a submit button inside a form with a real action URL submits the form, and any `href`, `target`, or `state_to` on the element is followed.
* Aborting stops every remaining action in the chain, including the trailing submit and link behavior.

---

## Announcements

All updates to this library are documented in our [CHANGELOG](https://github.com/CoCreate-app/CoCreate-actions/blob/master/CHANGELOG.md) and [releases](https://github.com/CoCreate-app/CoCreate-actions/releases). You may also subscribe to email for releases and breaking changes.

---

## Roadmap

Upcoming enhancements include:

* Conditional actions and branching
* Parallel action groups
* Error handling and retry policies
* Named chains reusable across elements
* Development mode tracing of chain execution

If you are interested in the future direction of this project, please take a look at our open [issues](https://github.com/CoCreate-app/CoCreate-actions/issues) and [pull requests](https://github.com/CoCreate-app/CoCreate-actions/pulls). We would love to hear your feedback.

---

## How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING](https://github.com/CoCreate-app/CoCreate-actions/blob/master/CONTRIBUTING.md) guide for details.

We want this library to be community-driven, and CoCreate led. We need your help to realize this goal. To help make sure we are building the right things in the right order, we ask that you create [issues](https://github.com/CoCreate-app/CoCreate-actions/issues) and [pull requests](https://github.com/CoCreate-app/CoCreate-actions/pulls) or merely upvote or comment on existing issues or pull requests.

We appreciate your continued support, thank you!

---

## About

CoCreate-actions is guided and supported by the CoCreate Developer Experience Team.

Please Email the Developer Experience Team [here](mailto:develop@cocreate.app) in case of any queries.

CoCreate-actions is maintained and funded by CoCreate. The names and logos for CoCreate are trademarks of CoCreate, LLC.

---

## License

[The MIT License (MIT)](https://github.com/CoCreate-app/CoCreate-actions/blob/master/LICENSE)
