import Observer from "@cocreate/observer";
import { queryElements, uuid } from "@cocreate/utils";
import "@cocreate/element-prototype";

const attribute = "actions";
const actionDefinitions = {};
const pendingInvocations = new WeakMap();

function getErrorTargets(element) {
    const root = element.getRootNode();
    return (element.getAttribute("aria-errormessage") || "")
        .trim().split(/\s+/).filter(Boolean)
        .map(id => root.getElementById?.(id)).filter(Boolean);
}

function setErrorMessage(element, message = "") {
    const targets = getErrorTargets(element);
    for (const target of targets) {
        target.setValue(message);
        target.hidden = !message;
    }
    if (element.hasAttribute("aria-errormessage")) {
        element.setAttribute("aria-invalid", String(Boolean(message) && targets.length > 0));
    }
}

function createActionError(element, action, reason) {
    const frame = {
        element,
        action: {
            name: action.name,
            method: action.method,
            params: action.params
        }
    };
    if (Array.isArray(reason?.path)) {
        return { ...reason, path: [frame, ...reason.path] };
    }
    const detail = reason instanceof Error
        ? { message: reason.message, cause: reason }
        : typeof reason === "string" ? { message: reason } : reason || {};
    return {
        ...detail,
        code: detail.code || "action-aborted",
        message: detail.message,
        selector: detail.selector ?? action.params,
        element,
        action: frame.action,
        cause: detail.cause,
        path: [frame]
    };
}

/**
 * Register { name, callback, endEvent }; name accepts a string or array of aliases.
 * Call end() or continue() to advance, or abort(reason) to stop the chain.
 * An abort reason may be an Error, string, or { code, message, selector, cause }.
 * Callback promises report rejections; fulfillment does not advance the chain.
 * @public
 * @environment client
 */
function init(data) {
    if (!Array.isArray(data)) data = [data];
    for (let { name, callback, endEvent } of data) {
        if (!Array.isArray(name)) name = [name];
        for (let i = 0; i < name.length; i++) {
            if (actionDefinitions[name[i]]) continue;

            actionDefinitions[name[i]] = {
                name: name[i],
                callback,
                endEvent: endEvent || name[i]
            };
        }
    }
}

const configuredHrefHandler = globalThis.CoCreate?.actions?.href;
const CoCreateActions = {
    init,
    // Replace CoCreate.actions.href to customize navigation for completed chains.
    href: configuredHrefHandler === undefined ? runLink : configuredHrefHandler
};

function initActions(elements) {
    if (!elements) {
        elements = document.querySelectorAll("[actions]");
    } else if (
        !(elements instanceof HTMLCollection) &&
        !(elements instanceof NodeList) &&
        !Array.isArray(elements)
    ) {
        elements = [elements];
    }

    // Add click event listeners to elements
    for (let i = 0; i < elements.length; i++) {
        initEvent(elements[i]);
    }
}

function initEvent(element) {
    element.addEventListener("click", handleClick);
}

function handleClick(event) {
    const target = event.target.closest?.(`[${attribute}]`);
    if (target !== event.currentTarget) return;

    if (target.tagName.toLowerCase() === "form") {
        const pattern =
            /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(:\d{1,5})?(\/.*)?$/i;
        if (pattern.test(target.action)) return target.submit();
    }

    if (target.getAttribute(`${attribute}-prevent-default`) !== "false") {
        event.preventDefault();
    }

    setErrorMessage(target);

    // Action selectors are parsed by queryElements, not the attribute AST.
    const actionList = (target.attributes.getNamedItem(attribute)?.value || "").split(/\s*,\s*/);
    const stagedActions = [];
    const invocation = pendingInvocations.get(target) || { invocationId: uuid(6) };
    invocation.event = event;
    pendingInvocations.delete(target);
    for (const action of actionList) {
        let [name, params] = action.split("(");
        if (params) params = params.substring(0, params.length - 1);

        stagedActions.push({ name, params });
    }

    runAction(stagedActions, 0, target, invocation);
}

function finishChain(element, invocation, success, error) {
    if (invocation.settled) return;
    invocation.settled = true;
    if (!success) {
        invocation.disabledButton?.removeAttribute("disabled");
        if (error?.message) setErrorMessage(element, error.message);
    }
    element.dispatchEvent(new CustomEvent(success ? "actionsEnd" : "actionsAbort", {
        detail: { invocationId: invocation.invocationId, error }
    }));
    if (success) invocation.resolve?.();
    else invocation.reject?.(error);
}

async function invokeActionTarget(target) {
    if (!target.hasAttribute(attribute)) {
        try {
            target.click();
        } catch (error) {
            throw createActionError(target, { name: "click" }, error);
        }
        return;
    }

    initEvent(target);
    return new Promise((resolve, reject) => {
        const invocation = { invocationId: uuid(6), resolve, reject };
        // The click handler consumes this invocation and settles it in finishChain.
        pendingInvocations.set(target, invocation);
        try {
            target.click();
            if (pendingInvocations.get(target) === invocation) {
                throw {
                    code: "action-not-started",
                    message: "The targeted action could not start."
                };
            }
        } catch (error) {
            reject(createActionError(target, { name: "action" }, error));
        } finally {
            if (pendingInvocations.get(target) === invocation)
                pendingInvocations.delete(target);
        }
    });
}

async function runAction(stagedActions, index, element, invocation) {
    if (invocation.settled) return;

    if (index >= stagedActions.length) {
        try {
            runSubmit(element);
            if (typeof CoCreateActions.href === "function") {
                await CoCreateActions.href(element, {
                    event: invocation.event,
                    invocationId: invocation.invocationId
                });
            }
            finishChain(element, invocation, true);
        } catch (error) {
            console.error("Action chain failed:", error);
            finishChain(element, invocation, false,
                createActionError(element, { name: "actions" }, error));
        }
        return;
    }

    const currentAction = stagedActions[index];
    if (!currentAction) return;

    let actionName = currentAction.name;
    if (actionName.includes(".")) {
        let name = actionName.split(".")[0];
        currentAction.method = actionName.substring(name.length + 1);
        currentAction.name = actionName = name;
        currentAction.endEvent =  uuid(6);
    }

    const actionDefinition = actionDefinitions[actionName];

    if (actionDefinition) {
        const resolvedEndEvent =
            currentAction.endEvent || actionDefinition.endEvent;
        let isResolved = false;

        const resolveCurrentAction = (shouldContinue = true, reason) => {
            if (isResolved) return;
            isResolved = true;
            element.removeEventListener(resolvedEndEvent, onActionEnd);

            if (!shouldContinue) {
                finishChain(element, invocation, false,
                    createActionError(element, currentAction, reason));
                return;
            }

            runNextAction(stagedActions, index, element, invocation);
        };

        const onActionEnd = () => resolveCurrentAction(true);
        element.addEventListener(resolvedEndEvent, onActionEnd, { once: true });

        if (actionDefinition.callback) {
            const form = element.closest("form");
            currentAction.name = actionName;
            currentAction.endEvent = resolvedEndEvent;
            currentAction.continue = () => {
                resolveCurrentAction(true);
            };
            currentAction.abort = (reason) => {
                resolveCurrentAction(false, reason);
            };
            currentAction.end = (detail = {}) => {
                if (isResolved) return;

                element.dispatchEvent(
                    new CustomEvent(resolvedEndEvent, {
                        bubbles: true,
                        detail: {
                            element,
                            form,
                            action: {
                                name: actionName,
                                method: currentAction.method,
                                params: currentAction.params,
                                endEvent: resolvedEndEvent
                            },
                            ...detail
                        }
                    })
                );
            };

            try {
                await actionDefinition.callback.call(null, {
                    element,
                    form,
                    ...currentAction
                });
            } catch (error) {
                console.error(`Action ${actionName} failed:`, error);
                resolveCurrentAction(false, error);
            }
        } else resolveCurrentAction(true);
    } else {
        try {
            const shouldContinue = await runBuiltInAction(
                stagedActions,
                index,
                element,
                actionName,
                currentAction.params,
                invocation
            );
            if (shouldContinue) {
                runNextAction(stagedActions, index, element, invocation);
            }
        } catch (error) {
            console.error(`Action ${actionName} failed:`, error);
            finishChain(element, invocation, false,
                createActionError(element, currentAction, error));
        }
    }
}

async function runBuiltInAction(stagedActions, index, element, actionName, params, invocation) {
    if (actionName === "action" && !params) {
        throw {
            code: "missing-action-selector",
            message: "No action target was specified."
        };
    }
    if (!params && actionName !== "submit" && actionName !== "disabled") return true;
    switch (actionName) {
        case "event":
            element.addEventListener(
                params,
                () => runNextAction(stagedActions, index, element, invocation),
                { once: true }
            );
            return false;
        case "timeout": {
            const delay = parseInt(params);
            if (delay > 0) {
                setTimeout(() => runNextAction(stagedActions, index, element, invocation), delay);
            }
            return false;
        }
        case "action": {
            const elements = queryElements({ element, selector: params, type: "selector" });
            if (!elements.length) {
                throw {
                    code: "action-target-not-found",
                    message: "The targeted action could not be found.",
                    selector: params
                };
            }
            await Promise.all(elements.map(invokeActionTarget));
            break;
        }
        case "submit": {
            const form = element.closest("form");
            if (form) {
                element.addEventListener(
                    "submitted",
                    () => runNextAction(stagedActions, index, element, invocation),
                    { once: true }
                );
                const submitEvent = new CustomEvent("submit", {
                    bubbles: true,
                    cancelable: true,
                    detail: { element, form }
                });
                if (form.dispatchEvent(submitEvent)) form.submit();
            }
            return false;
        }
        case "disabled": {
            const button = element.closest("button");
            if (button) {
                if (button.hasAttribute("disabled")) {
                    button.removeAttribute("disabled");
                } else {
                    button.setAttribute("disabled", "");
                    invocation.disabledButton = button;
                }
            }
            break;
        }
        default: {
            const elements = queryElements({ element, selector: params, type: "selector" });
            try {
                await Promise.all(elements.map(async target => {
                    if (typeof target[actionName] === "function") {
                        await target[actionName]();
                    }
                }));
            } catch (error) {
                throw {
                    code: "action-method-failed",
                    message: error?.message || `The ${actionName} action could not complete.`,
                    cause: error
                };
            }
        }
    }
    return true;
}

function runNextAction(stagedActions, index, element, invocation) {
    runAction(stagedActions, index + 1, element, invocation);
}

function runSubmit(element) {
    let button = element.closest('[type="submit"]');
    if (!button) button = element.querySelector('[type="submit"]');
    if (button) {
        let form = element.closest("form");
        if (form && form.action) {
            const pattern =
                /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(:\d{1,5})?(\/.*)?$/i;
            if (pattern.test(form.action)) form.submit();
        }
    }
}

function runLink(element) {
    let link = element.closest("[href], [target], [state_to]");
    if (!link) link = element.querySelector("[href], [target], [state_to]");
    if (!link || link.hasAttribute("download")) return;

    run(link);
}

function run(link) {
    /**
     * Completion handler called after a successful chain. It can be supplied through CoCreate.actions.href or replaced on the default exported API object; otherwise Actions uses its built-in href handler.
     *
 * @public
 * @environment client
 */
    const href = link.getAttribute("href");
    if (!href) return;

    const target = link.getAttribute("target");
    if (target && target !== "_self") {
        window.open(href, target);
        return;
    }

    const currentUrl = new URL(location.href);
    const targetUrl = new URL(href, location.href);
    const currentPath = currentUrl.pathname.replace("/index.html", "/");
    const targetPath = targetUrl.pathname.replace("/index.html", "/");

    if (currentPath !== targetPath || currentUrl.hash !== targetUrl.hash) {
        location.href = href;
    }
}

Observer.init({
    name: "actions",
    types: ["addedNodes"],
    selector: "[actions]",
    callback(mutation) {
        initActions(mutation.target);
    }
});

initActions();

export default CoCreateActions;

/**
 * Dispatched when the full chain completes successfully.
 *
 * @name actionsEnd
 * @kind member
 * @public
 * @environment client
 */

/**
 * Dispatched when the full chain aborts.
 *
 * @name actionsAbort
 * @kind member
 * @public
 * @environment client
 */

/**
 * Dispatched by a registered action's end(detail); it bubbles and includes element, form, action metadata, and the supplied detail.
 *
 * @name action endEvent
 * @kind member
 * @public
 * @environment client
 */

/**
 * Runs actions in order when the element is clicked. Names may refer to built-in actions or actions registered by modules.
 *
 * @name actions
 * @kind member
 * @attribute
 * @valueType string
 * @environment client
 */

/**
 * Set to the string "false" to allow the click's default browser behavior; otherwise Actions prevents it.
 *
 * @name actions-prevent-default
 * @kind member
 * @attribute
 * @valueType string
 * @acceptedValues false
 * @environment client
 */

/**
 * Declarative actions supported or registered by this module.
 *
 * @name declarative-actions
 * @kind member
 * @actions
 * @environment client
 * @example
 * ```json
 * [
 *   {
 *     "name": "event",
 *     "syntax": "event(eventName)",
 *     "description": "Waits for the named event on the action element before continuing."
 *   },
 *   {
 *     "name": "timeout",
 *     "syntax": "timeout(milliseconds)",
 *     "description": "Waits for a positive delay before continuing."
 *   },
 *   {
 *     "name": "action",
 *     "syntax": "action(selector)",
 *     "description": "Clicks matching elements and waits for their action chains to complete."
 *   },
 *   {
 *     "name": "submit",
 *     "description": "Dispatches a cancelable submit event for the closest form and waits for its submitted event."
 *   },
 *   {
 *     "name": "disabled",
 *     "description": "Toggles the closest button's disabled attribute. If the chain aborts, Actions re-enables a button it disabled."
 *   },
 *   {
 *     "name": "elementMethod",
 *     "syntax": "methodName(selector)",
 *     "description": "For other action names, queries matching elements and invokes a same-named method on each element when available."
 *   }
 * ]
 * ```
 */

/**
 * Registration contract for declarative actions.
 *
 * @name declarative-registeredActions
 * @kind member
 * @registeredActions
 * @environment client
 * @example
 * ```json
 * {
 *   "syntax": "actionName[(parameters)]",
 *   "methodSyntax": "actionName.methodName[(parameters)]",
 *   "description": "Other modules register actions through the JavaScript API. Dotted syntax supplies a method to the registered action callback."
 * }
 * ```
 */

/**
 * Declarative binding behavior for this module.
 *
 * @name declarative-binding
 * @kind member
 * @binding
 * @environment client
 * @example
 * ```json
 * {
 *   "selector": "[actions]",
 *   "trigger": "click",
 *   "initializesExistingElements": true,
 *   "observesAddedNodes": true
 * }
 * ```
 */
