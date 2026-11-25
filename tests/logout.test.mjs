// Logging out with apps that close, apps that ask first, and apps that do
// not answer. The shell is plain objects; timeouts run when a test says so.

let failures = 0;
const expect = (label, ok, detail = '') => {
    if (!ok)
        failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};

let timers = new Map();
let nextId = 0;
const runTimers = () => {
    const due = [...timers.values()];
    timers = new Map();
    due.forEach(callback => callback());
};
const settle = () => new Promise(resolve => setImmediate(resolve));

const displayHandlers = {};
const actors = [];
const activated = [];
const notifications = [];

globalThis.logoutStubs = {
    GLib: {
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add: (_priority, _ms, callback) => {
            const id = ++nextId;
            timers.set(id, callback);
            return id;
        },
        source_remove: id => timers.delete(id),
    },
    Meta: {WindowType: {NORMAL: 0, DESKTOP: 1, DIALOG: 3}},
    Shell: {
        WindowTracker: {
            get_default: () => ({get_window_app: window => window.app
                ? {get_name: () => window.app} : null}),
        },
    },
    Main: {
        endSessionDialog: null,
        activateWindow: window => activated.push(window.title),
        messageTray: {add() {}},
    },
    MessageTray: {
        Urgency: {CRITICAL: 3},
        Source: class { constructor(params) { Object.assign(this, params); } connect() {} destroy() {}
            addNotification(n) { notifications.push(n); } },
        Notification: class { constructor(params) { Object.assign(this, params); } connect() {} },
    },
    global: {
        get_window_actors: () => actors.filter(actor => actor.meta_window.managed)
            .map(actor => actor),
        get_current_time: () => 0,
        display: {
            connectObject(...args) {
                for (let i = 0; i + 1 < args.length; i += 2)
                    displayHandlers[args[i]] = args[i + 1];
            },
            disconnectObject() {
                for (const key of Object.keys(displayHandlers))
                    delete displayHandlers[key];
            },
        },
    },
};

const {LogoutGuard, closable, warning} = await import('./.logout-under-test.mjs');
const {Main} = globalThis.logoutStubs;

// A window, and what its app does when asked to close: 'close', 'ask', or
// nothing at all.
let pid = 100;
const win = (title, app, answer = 'close', extra = {}) => {
    const window = {
        title, app, answer, managed: true, pid: ++pid, handlers: {},
        is_override_redirect: () => false,
        get_window_type: () => 0,
        is_skip_taskbar: () => false,
        get_transient_for: () => null,
        can_close: () => true,
        get_pid() { return this.pid; },
        get_wm_class: () => null,
        get_title() { return this.title; },
        get_compositor_private() { return this.managed ? {} : null; },
        connectObject(...args) {
            for (let i = 0; i + 1 < args.length; i += 2)
                this.handlers[args[i]] = args[i + 1];
        },
        disconnectObject() { this.handlers = {}; },
        unmanage() {
            this.managed = false;
            this.handlers.unmanaging?.();
        },
        delete() {
            if (this.answer === 'close') {
                queueMicrotask(() => this.unmanage());
            } else if (this.answer === 'ask') {
                const prompt = win(`${this.title}: close all tabs?`, this.app, 'none',
                    {get_transient_for: () => this});
                prompt.pid = this.pid;
                queueMicrotask(() => displayHandlers['window-created']?.(null, prompt));
            }
        },
        ...extra,
    };
    actors.push({meta_window: window});
    return window;
};

// The end-session dialog as the guard uses it: the signal it would send.
const sent = [];
const makeDialog = () => {
    const proto = {async _confirm(signal) { sent.push(signal); }};
    const dialog = Object.create(proto);
    Object.assign(dialog, {
        closed: false,
        _stopTimer() {},
        close() { this.closed = true; },
        cancel() { sent.push('Canceled'); },
    });
    return dialog;
};
const reset = () => {
    sent.length = activated.length = notifications.length = actors.length = 0;
    timers = new Map();
};

console.log('\nwhich windows are asked');
expect('an app window', closable(win('Editor', 'Text Editor')));
expect('not a dialog, which closes with its parent',
    !closable(win('Save?', 'Text Editor', 'close', {get_transient_for: () => ({})})));
expect('not the desktop', !closable(win('Desktop', null, 'close', {get_window_type: () => 1})));
expect('not one kept off the taskbar', !closable(win('Tray', null, 'close', {is_skip_taskbar: () => true})));
expect('not one that cannot be closed', !closable(win('Kiosk', null, 'close', {can_close: () => false})));
reset();

console.log('\nevery app closes  (the logout goes ahead)');
Main.endSessionDialog = makeDialog();
let guard = new LogoutGuard();
guard.enable();
win('Files', 'Files');
win('Notes', 'Text Editor');
await Main.endSessionDialog._confirm('ConfirmedLogout');
expect('GNOME is told to go ahead', sent.join() === 'ConfirmedLogout', sent.join());
expect('with no warning', notifications.length === 0);
reset();

console.log('\nnothing open  (straight through)');
await Main.endSessionDialog._confirm('ConfirmedShutdown');
expect('power off goes ahead', sent.join() === 'ConfirmedShutdown', sent.join());
reset();

console.log('\nan app asks first  (the logout is cancelled)');
win('Files', 'Files');
const brave = win('News', 'Brave', 'ask');
const pending = Main.endSessionDialog._confirm('ConfirmedShutdown');
await settle();
runTimers();
await pending;
expect('GNOME is told to cancel', sent.join() === 'Canceled', sent.join());
expect('the prompt is brought forward', activated.join() === 'News: close all tabs?', activated.join());
expect('a warning is shown', notifications.length === 1 && notifications[0].urgency === 3);
expect('naming the app and what to do', notifications[0]?.title === 'Power off cancelled' &&
    notifications[0]?.body === 'Brave is asking before it closes. Deal with it, then power off again.',
`${notifications[0]?.title}: ${notifications[0]?.body}`);
expect('apps that could close have', !actors[0].meta_window.managed && brave.managed);
reset();

console.log('\nan app does not answer  (cancelled once the wait is over)');
const stuck = win('Draft', 'Writer', 'none');
const waiting = Main.endSessionDialog._confirm('ConfirmedReboot');
await settle();
expect('nothing is sent while it waits', sent.length === 0, sent.join());
runTimers();
await waiting;
expect('then GNOME is told to cancel', sent.join() === 'Canceled', sent.join());
expect('and the window is brought forward', activated.join() === 'Draft', activated.join());
expect('the warning says it did not close', notifications[0]?.body ===
    'Writer did not close, and may have unsaved work. Deal with it, then restart again.',
notifications[0]?.body);
expect('nothing is left waiting', timers.size === 0 && !displayHandlers['window-created']);
stuck.unmanage();
reset();

console.log('\nthe warning  (several apps)');
const several = warning('ConfirmedLogout', [{name: 'Brave', asked: true},
    {name: 'Terminal', asked: true}, {name: 'Writer', asked: false}]);
expect('lists them', several.body === 'Brave and Terminal are asking before they close. ' +
    'Writer did not close, and may have unsaved work. Deal with them, then log out again.', several.body);

console.log('\ndisable  (the dialog is as GNOME made it)');
guard.disable();
expect('its own confirm is back', !Object.hasOwn(Main.endSessionDialog, '_confirm'));
win('Notes', 'Text Editor', 'ask');
await Main.endSessionDialog._confirm('ConfirmedLogout');
expect('and logs out without asking', sent.join() === 'ConfirmedLogout', sent.join());
reset();

console.log('\nno dialog  (a session without one)');
Main.endSessionDialog = null;
guard = new LogoutGuard();
guard.enable();
guard.disable();
expect('enable and disable do nothing', true);

console.log(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
process.exit(failures ? 1 : 0);
