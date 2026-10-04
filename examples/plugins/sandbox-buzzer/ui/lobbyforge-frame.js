// @lobbyforge/plugin-sdk/frame — the frame client, as plain ESM with no imports.
// Generated from packages/plugin-sdk/src/frame/client.ts by
// packages/plugin-sdk/scripts/vendor-frame-client.mjs. Do not edit: re-run it.
const LF = 1;
const READY_RETRY_MS = 250;
const READY_RETRY_LIMIT = 40;
const THEME_VARIABLE_RE = /^--lf-[a-z0-9-]{1,64}$/;
const MAX_THEME_VALUE_LENGTH = 200;
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Where messages to the parent go. The asset route only lets the app's own
 * pages frame it (`frame-ancestors 'self'`), so the parent is on the frame
 * URL's host; `location.origin` is that URL's origin even though the frame's
 * own origin is opaque.
 */
function parentOrigin(win) {
    try {
        const origin = win.location.origin;
        if (origin.startsWith('http://') || origin.startsWith('https://'))
            return origin;
    }
    catch {
        // Fall through.
    }
    return '*';
}
function toScheme(value) {
    return value === 'light' || value === 'dim' ? value : 'dark';
}
function readTheme(value) {
    const vars = {};
    if (isObject(value) && isObject(value.vars)) {
        for (const [name, v] of Object.entries(value.vars)) {
            if (THEME_VARIABLE_RE.test(name) && typeof v === 'string' && v.length <= MAX_THEME_VALUE_LENGTH) {
                vars[name] = v;
            }
        }
    }
    return { scheme: toScheme(isObject(value) ? value.scheme : undefined), vars };
}
function readPlayers(value) {
    if (!Array.isArray(value))
        return [];
    const players = [];
    for (const p of value) {
        if (!isObject(p) || typeof p.userId !== 'string')
            continue;
        players.push({
            userId: p.userId,
            name: typeof p.name === 'string' ? p.name : null,
            isHost: p.isHost === true,
        });
    }
    return players;
}
function readViewer(value) {
    if (!isObject(value))
        return { userId: '', isHost: false };
    return { userId: typeof value.userId === 'string' ? value.userId : '', isHost: value.isHost === true };
}
function applyThemeTo(doc, theme, locale) {
    const root = doc.documentElement;
    if (!root)
        return;
    for (const [name, value] of Object.entries(theme.vars))
        root.style.setProperty(name, value);
    root.setAttribute('data-lf-theme', theme.scheme);
    root.style.setProperty('color-scheme', theme.scheme === 'light' ? 'light' : 'dark');
    if (locale)
        root.setAttribute('lang', locale);
}
/** Height of `el` including its vertical margins, rounded up. */
function measure(win, el) {
    const rect = el.getBoundingClientRect();
    let margins = 0;
    try {
        const style = win.getComputedStyle(el);
        margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }
    catch {
        margins = 0;
    }
    return Math.ceil(rect.height + margins);
}
/** Connect this frame to the LobbyForge parent. Call it once, when the script starts. */
export function connect(options = {}) {
    const win = options.window ?? window;
    const doc = win.document;
    const parent = win.parent;
    const embedded = Boolean(parent) && parent !== win;
    const targetOrigin = parentOrigin(win);
    const applyTheme = options.applyTheme !== false;
    let connected = false;
    let closed = false;
    let lastHeight = -1;
    let readyTries = 0;
    let readyTimer = null;
    let measureQueued = false;
    let observer = null;
    let observed = null;
    const post = (message) => {
        if (!embedded || closed)
            return;
        parent.postMessage(message, targetOrigin);
    };
    const stopReady = () => {
        if (readyTimer !== null) {
            win.clearInterval(readyTimer);
            readyTimer = null;
        }
    };
    const resize = (height) => {
        if (typeof height !== 'number' || !Number.isFinite(height) || height < 0)
            return;
        const rounded = Math.ceil(height);
        if (rounded === lastHeight)
            return;
        lastHeight = rounded;
        post({ lf: LF, type: 'resize', height: rounded });
    };
    const measureNow = () => {
        measureQueued = false;
        if (closed || !observed)
            return;
        resize(measure(win, observed));
    };
    const queueMeasure = () => {
        if (measureQueued || closed)
            return;
        measureQueued = true;
        if (typeof win.requestAnimationFrame === 'function')
            win.requestAnimationFrame(measureNow);
        else
            win.setTimeout(measureNow, 16);
    };
    const onMessage = (event) => {
        if (closed || event.source !== parent)
            return;
        if (targetOrigin !== '*' && event.origin !== targetOrigin)
            return;
        const data = event.data;
        if (!isObject(data) || data.lf !== LF)
            return;
        if (data.type === 'init') {
            const init = {
                viewer: readViewer(data.viewer),
                players: readPlayers(data.players),
                locale: typeof data.locale === 'string' ? data.locale : '',
                theme: readTheme(data.theme),
                state: data.state,
                revision: typeof data.revision === 'number' ? data.revision : 0,
            };
            connected = true;
            stopReady();
            if (applyTheme)
                applyThemeTo(doc, init.theme, init.locale);
            options.onInit?.(init);
            options.onState?.(init.state, init.revision);
            // A re-init may have changed what is shown: report the height again.
            lastHeight = -1;
            queueMeasure();
            return;
        }
        if (data.type === 'state') {
            if (!connected)
                return;
            options.onState?.(data.state, typeof data.revision === 'number' ? data.revision : 0);
        }
    };
    win.addEventListener('message', onMessage);
    if (embedded) {
        post({ lf: LF, type: 'ready' });
        readyTimer = win.setInterval(() => {
            readyTries += 1;
            if (connected || readyTries >= READY_RETRY_LIMIT) {
                stopReady();
                return;
            }
            post({ lf: LF, type: 'ready' });
        }, READY_RETRY_MS);
    }
    if (options.autoResize !== false) {
        observed =
            typeof options.autoResize === 'object' && options.autoResize !== null
                ? options.autoResize
                : (doc.body ?? doc.documentElement);
        const RO = win.ResizeObserver;
        if (observed && typeof RO === 'function') {
            observer = new RO(queueMeasure);
            observer.observe(observed);
        }
        queueMeasure();
    }
    return {
        dispatch(action) {
            if (!isObject(action) || typeof action.type !== 'string' || action.type.length === 0) {
                throw new TypeError('dispatch() needs an object with a non-empty string `type`.');
            }
            // Only JSON crosses to the host; this also throws on cycles and BigInt.
            const clean = JSON.parse(JSON.stringify(action));
            post({ lf: LF, type: 'action', action: clean });
        },
        resize,
        get connected() {
            return connected;
        },
        close() {
            if (closed)
                return;
            closed = true;
            stopReady();
            observer?.disconnect();
            observer = null;
            win.removeEventListener('message', onMessage);
        },
    };
}
