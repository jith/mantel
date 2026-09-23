// Just enough of St, Clutter, Shell, Meta and the shell globals for
// outline.js: an ordered window group, an effect that remembers the uniforms
// it was given, and objects that remember what is connected to them so a test
// can fire a signal and check that nothing is left connected afterwards.
export const Meta = {WindowType: {NORMAL: 0, DIALOG: 3, MODAL_DIALOG: 4, POPUP_MENU: 9}};

const children = [];
const without = actor => {
    const i = children.indexOf(actor);
    if (i !== -1) children.splice(i, 1);
};

export const restacks = {count: 0};

// The accent colour the stylesheet would hand the widget, as St reports it:
// bytes, not fractions.
export const accent = {red: 211, green: 70, blue: 21, alpha: 255};

class Signals {
    constructor() { this.handlers = new Map(); }
    connectObject(...args) {
        for (let i = 0; i + 1 < args.length - 1; i += 2)
            this.handlers.set(args[i], args[i + 1]);
    }
    disconnectObject() { this.handlers.clear(); }
    emit(name) { this.handlers.get(name)?.(this); }
}

class Widget extends Signals {
    constructor(props) {
        super();
        Object.assign(this, {x: 0, y: 0, width: 0, height: 0, effects: []}, props);
        this.children = [];
    }
    add_child(child) { this.children.push(child); }
    add_effect(effect) { this.effects.push(effect); }
    get_theme_node() { return {get_border_color: () => accent}; }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(width, height) { this.width = width; this.height = height; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { without(this); this.destroyed = true; }
    get_next_sibling() { return children[children.indexOf(this) + 1] ?? null; }
}
export const St = {Widget, Side: {TOP: 0}};

export const Clutter = {
    Clone: class Clone {
        constructor(props) { Object.assign(this, {source: null}, props); }
    },
};

export const Cogl = {SnippetHook: {FRAGMENT: 'fragment'}};

export const GObject = {registerClass: (...args) => args[args.length - 1]};

// Shell.GLSLEffect builds its pipeline as it is constructed, which is what
// gives out the uniform locations, so the stub does the same.
export const Shell = {
    GLSLEffect: class GLSLEffect {
        constructor() {
            this.snippets = [];
            this.uniforms = new Map();
            this.sets = 0;
            this.repaints = 0;
            this.vfunc_build_pipeline();
        }
        add_glsl_snippet(hook, declarations, code) {
            this.snippets.push({hook, declarations, code});
        }
        get_uniform_location(name) { return name; }
        set_uniform_float(location, size, values) {
            if (values.length !== size)
                throw new Error(`${location}: ${values.length} values for a vec${size}`);
            this.uniforms.set(location, values);
            this.sets++;
        }
        queue_repaint() { this.repaints++; }
    },
};

export const global = {
    window_group: {
        add_child: actor => children.push(actor),
        set_child_below_sibling(actor, sibling) {
            without(actor);
            children.splice(children.indexOf(sibling), 0, actor);
            restacks.count++;
        },
    },
    display: Object.assign(new Signals(), {focus_window: null}),
};

export const stack = () => children;
export const raise = actor => { without(actor); children.push(actor); };

// The shadow a client draws around itself, which is in the buffer but not in
// the frame.
export const SHADOW = 26;

// A window and its actor, already in the group, as mutter would have them.
export class Window extends Signals {
    constructor(rect, props = {}) {
        super();
        Object.assign(this, {
            rect, type: Meta.WindowType.NORMAL, minimized: false,
            fullscreen: false, maximizedHorizontally: false, maximizedVertically: false,
        }, props);
        this.actor = {get_parent: () => global.window_group};
        children.push(this.actor);
    }
    get_compositor_private() { return this.actor; }
    get_window_type() { return this.type; }
    is_fullscreen() { return this.fullscreen; }
    is_maximized() { return this.maximizedHorizontally && this.maximizedVertically; }
    get_frame_rect() { return this.rect; }
    get_buffer_rect() {
        return {
            x: this.rect.x - SHADOW, y: this.rect.y - SHADOW,
            width: this.rect.width + 2 * SHADOW, height: this.rect.height + 2 * SHADOW,
        };
    }
}

export const focus = window => {
    global.display.focus_window = window;
    global.display.emit('notify::focus-window');
};
