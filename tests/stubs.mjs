// What tiling.js asks of the shell, as plain objects.

// Timeouts run at once, unless a test holds them to run later with pump().
// The clock moves a quarter second each time it is read.
let clock = 0;
let step = 250;
let held = null;
let nextId = 0;
export const clockStep = ms => (step = ms);
export const tick = ms => (clock += ms);
export const hold = () => (held = new Map());
export const pump = () => {
    let ran = 0;
    while (held?.size && ran < 1000) {
        const [id, callback] = held.entries().next().value;
        held.delete(id);
        callback();
        ran++;
    }
    return ran;
};
export const release = () => (held = null);
export const queued = () => held?.size ?? 0;

export const GLib = {
    PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
    timeout_add: (_priority, _interval, callback) => {
        const id = ++nextId;
        if (held)
            held.set(id, callback);
        else
            callback();
        return id;
    },
    source_remove: id => held?.delete(id),
    get_monotonic_time: () => (clock += step) * 1000,
};

class Rectangle {
    constructor({x = 0, y = 0, width = 0, height = 0} = {}) {
        Object.assign(this, {x, y, width, height});
    }

    equal(r) {
        return this.x === r.x && this.y === r.y && this.width === r.width && this.height === r.height;
    }

    vert_overlap(r) { return this.y < r.y + r.height && r.y < this.y + this.height; }
    horiz_overlap(r) { return this.x < r.x + r.width && r.x < this.x + this.width; }
    contains_point(x, y) {
        return x >= this.x && x < this.x + this.width && y >= this.y && y < this.y + this.height;
    }

    toString() { return `${this.width}x${this.height}+${this.x}+${this.y}`; }
}
export const Mtk = {Rectangle};
export const rect = (x, y, width, height) => new Rectangle({x, y, width, height});

export const GDesktopEnums = {FocusMode: {CLICK: 0, SLOPPY: 1, MOUSE: 2}};
export let focusMode = GDesktopEnums.FocusMode.SLOPPY;
export const setFocusMode = mode => (focusMode = mode);

export const Meta = {
    prefs_get_workspaces_only_on_primary: () => true,
    prefs_get_focus_mode: () => focusMode,
    KeyBindingFlags: {IGNORE_AUTOREPEAT: 1},
    KeyBindingAction: {NONE: 0},
    TabList: {NORMAL: 0},
    DisplayDirection: {UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3},
    WindowType: {NORMAL: 0, DESKTOP: 1, DOCK: 2, DIALOG: 3, MODAL_DIALOG: 4, UTILITY: 7},
    // Only the 1024 flag mutter adds to a grab has to be the real one.
    GrabOp: {
        MOVING: 1, KEYBOARD_MOVING: 2,
        RESIZING_N: 10, RESIZING_NE: 11, RESIZING_E: 12, RESIZING_SE: 13,
        RESIZING_S: 14, RESIZING_SW: 15, RESIZING_W: 16, RESIZING_NW: 17,
        KEYBOARD_RESIZING_UNKNOWN: 20, KEYBOARD_RESIZING_N: 21,
    },
};

// Every chord bound, so a test can hold them against the schema.
export const bound = [];
export const chords = new Map();
export const Main = {
    wm: {
        addKeybinding: (name, _settings, _flags, _mode, handler) => {
            bound.push(name);
            chords.set(name, handler);
            return 1;
        },
        removeKeybinding: name => bound.splice(bound.indexOf(name), 1),
    },
    sessionMode: {
        isLocked: false,
        connectObject(_signal, handler) { this.updated = handler; },
        disconnectObject() { this.updated = null; },
    },
};

// The desktop file a window was matched to, by title.
export const apps = new Map();
export const Shell = {
    ActionMode: {NORMAL: 1},
    WindowTracker: {
        get_default: () => ({
            get_window_app: window => apps.has(window.title)
                ? {get_id: () => apps.get(window.title)} : null,
        }),
    },
};

export let mru = [];
export const setMru = list => (mru = list);

let workspaceIndex = 0;
export const setWorkspaceIndex = index => (workspaceIndex = index);
export const workspace = {
    index: () => workspaceIndex,
    get_work_area_for_monitor: () => rect(0, 0, 1536, 960),
};

let pointer = [0, 0, 0];
export const setPointer = (x, y) => (pointer = [x, y, 0]);

export const global = {
    display: {
        focus_window: null,
        get_tab_list: () => mru,
        connectObject() {}, disconnectObject() {},
        get_monitor_scale: () => 1,
        get_n_monitors: () => 2,
        // Monitor 1 is right of monitor 0.
        get_monitor_neighbor_index: (monitor, direction) =>
            ({0: {[Meta.DisplayDirection.RIGHT]: 1}, 1: {[Meta.DisplayDirection.LEFT]: 0}})[monitor]?.[direction] ?? -1,
        // Bottom to top, by the stack position a window was last raised to.
        sort_windows_by_stacking: windows =>
            [...windows].sort((a, b) => a.stacked - b.stacked),
    },
    get_current_time: () => 0,
    get_pointer: () => pointer,
    stage: {
        get_context: () => ({
            get_backend: () => ({
                get_default_seat: () => ({warp_pointer: (x, y) => setPointer(x, y)}),
            }),
        }),
    },
    workspace_manager: {
        get_workspace_by_index: () => workspace,
        get_active_workspace: () => workspace,
        connectObject() {}, disconnectObject() {},
    },
    get_window_actors: () => [],
};
export const setFocus = window => (global.display.focus_window = window);

export class FocusOutline {
    constructor() {
        this.width = 0;
        this.syncs = 0;
    }

    sync() { this.syncs++; }
    destroy() {}
}

// GSettings as a borrowed setting uses it: a user value over a default, so
// that handing back a default can be told apart from writing a copy of it.
export class Settings {
    constructor(defaults) {
        this.defaults = defaults;
        this.user = {};
        this.handlers = {};
        this.settings_schema = {has_key: key => key in defaults};
    }

    get_user_value(key) {
        return key in this.user ? {deepUnpack: () => this.user[key]} : null;
    }

    get_default_value(key) {
        return {deepUnpack: () => this.defaults[key]};
    }

    _get(key) { return key in this.user ? this.user[key] : this.defaults[key]; }
    get_string(key) { return this._get(key); }
    get_int(key) { return this._get(key); }
    get_boolean(key) { return this._get(key); }
    get_strv(key) { return [...this._get(key)]; }
    _set(key, value) {
        this.user[key] = value;
        this.handlers[`changed::${key}`]?.();
    }

    set_string(key, value) { this._set(key, value); }
    set_int(key, value) { this._set(key, value); }
    set_boolean(key, value) { this._set(key, value); }
    set_strv(key, value) { this._set(key, [...value]); }
    reset(key) { delete this.user[key]; }

    connectObject(...args) {
        for (let i = 0; i + 1 < args.length; i += 2)
            this.handlers[args[i]] = args[i + 1];
    }

    disconnectObject() { this.handlers = {}; }
}

// The settings tiling borrows from, as Ubuntu ships them: Tiling Assistant
// has the arrows, so GNOME's maximize and tiling keys have none.
export const schemas = {};
export const installDefaults = () => Object.assign(schemas, {
    'org.gnome.desktop.wm.preferences': new Settings({
        'button-layout': ':minimize,maximize,close',
        'action-double-click-titlebar': 'toggle-maximize',
        'resize-with-right-button': false,
        'focus-mode': 'click',
    }),
    'org.gnome.desktop.wm.keybindings': new Settings({
        'minimize': ['<Super>h'],
        'maximize': [],
        'unmaximize': [],
        'toggle-maximized': ['<Alt>F10'],
        'maximize-horizontally': [],
        'maximize-vertically': [],
        'move-to-monitor-left': ['<Super><Shift>Left'],
        'move-to-monitor-right': ['<Super><Shift>Right'],
        'move-to-monitor-up': ['<Super><Shift>Up'],
        'move-to-monitor-down': ['<Super><Shift>Down'],
    }),
    'org.gnome.shell.keybindings': new Settings({'toggle-quick-settings': ['<Super>s']}),
    'org.gnome.settings-daemon.plugins.media-keys': new Settings({
        'magnifier-zoom-in': ['<Alt><Super>equal'],
        'magnifier-zoom-out': ['<Alt><Super>minus'],
    }),
    'org.gnome.mutter': new Settings({'edge-tiling': true, 'center-new-windows': false}),
    'org.gnome.mutter.keybindings': new Settings({
        'toggle-tiled-left': [],
        'toggle-tiled-right': [],
    }),
    'org.gnome.shell.extensions.tiling-assistant': new Settings({
        'focus-hint': 0,
        'default-move-mode': 0,
        'tile-maximize': ['<Super>Up', '<Super>KP_5'],
        'tile-maximize-horizontally': [],
        'tile-maximize-vertically': [],
        'tile-left-half': ['<Super>Left', '<Super>KP_4'],
        'tile-right-half': ['<Super>Right', '<Super>KP_6'],
    }),
});
installDefaults();

export const Gio = {
    Settings: class {
        constructor({schema_id: id}) {
            return schemas[id];
        }
    },
    SettingsSchemaSource: {
        get_default: () => ({
            lookup: id => schemas[id] ? {has_key: key => key in schemas[id].defaults} : null,
        }),
    },
};

// A window as mutter shows it: resizable, and taking whatever it is given.
// Signal handlers are kept by name, so a test can emit what mutter would.
let stackTop = 0;
export const limit = (width, height) => () => [true, width, height];
export const win = (title, extra = {}) => ({
    title, minimized: false, above: false, stuck: false, onAll: false, primary: true,
    monitor: 0, fullscreen: false, maxH: false, maxV: false, stacked: 0, placements: 0,
    frame: rect(100, 100, 600, 400),
    handlers: null, connected: new Map(),
    get_title() { return this.title; },
    get_min_size: () => [false, 0, 0],
    get_max_size: () => [false, 0, 0],
    get_role: () => null,
    get_wm_class: () => 'org.gnome.Ptyxis',
    get_window_type: () => 0,
    get_workspace: () => workspace,
    get_monitor() { return this.monitor; },
    get_compositor_private: () => ({}),
    get_transient_for: () => null,
    get_work_area_current_monitor: () => rect(0, 0, 1536, 960),
    get_frame_rect() { return this.frame; },
    get_maximize_flags() { return (this.maxH ? 1 : 0) | (this.maxV ? 2 : 0); },
    is_maximized() { return this.maxH && this.maxV; },
    is_fullscreen() { return this.fullscreen; },
    is_on_all_workspaces() { return this.onAll || this.stuck; },
    is_on_primary_monitor() { return this.primary; },
    is_skip_taskbar: () => false,
    is_attached_dialog: () => false,
    is_override_redirect: () => false,
    allows_move: () => true,
    allows_resize: () => true,
    located_on_workspace: () => true,
    activate() { setFocus(this); },
    has_focus() { return global.display.focus_window === this; },
    move_to_monitor(monitor) { this.monitor = monitor; },
    raise() { this.stacked = ++stackTop; },
    make_above() { this.above = true; },
    unmake_above() { this.above = false; },
    stick() { this.stuck = true; },
    unstick() { this.stuck = false; },
    minimize() { this.minimized = true; },
    unminimize() { this.minimized = false; },
    change_workspace() {},
    unmake_fullscreen() { this.fullscreen = false; },
    setMaximized(on) {
        this.maxH = this.maxV = on;
        this.emit('notify::maximized-horizontally');
        this.emit('notify::maximized-vertically');
    },
    maximize() {
        this.placements++;
        this.frame = rect(0, 0, 1536, 960);
        this.setMaximized(true);
    },
    unmaximize() { this.setMaximized(false); },
    move_frame(_userOp, x, y) { this.frame = rect(x, y, this.frame.width, this.frame.height); },
    move_resize_frame(_userOp, x, y, width, height) {
        this.placements++;
        this.frame = rect(x, y, width, height);
    },
    connectObject(...args) {
        this.handlers = {};
        for (let i = 0; i + 1 < args.length; i += 2)
            this.handlers[args[i]] = args[i + 1];
    },
    disconnectObject() { this.handlers = null; },
    connect(name, handler) {
        const id = this.connected.size + 1;
        this.connected.set(id, [name, handler]);
        return id;
    },
    disconnect(id) { this.connected.delete(id); },
    emit(name) {
        this.handlers?.[name]?.(this);
        for (const [signal, handler] of this.connected.values()) {
            if (signal === name)
                handler(this);
        }
    },
    ...extra,
});
