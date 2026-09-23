// SPDX-License-Identifier: GPL-3.0-or-later
//
// The outline around the focused window. Clients round their own corners, and
// mutter cannot say which radius one chose, so the outline is traced from the
// window: a copy of it, stacked just below it, is widened on the GPU, and what
// lands outside the window is the outline.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

// The alpha where the window ends and its shadow begins: a shadow is far
// fainter, a translucent window is not.
const SOLID = 0.35;

// Softness of that edge, so the outline is antialiased like the window.
const FEATHER = 0.2;

// Points sampled around the window to widen it; the dent between them stays
// under half a pixel at the widest border.
const SAMPLES = 24;

const OUTLINED = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
]);

// Widen what the actor drew, cut the actor back out, and paint the band left.
const Silhouette = GObject.registerClass(
class Silhouette extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        const declarations = `
            uniform vec2 spread;   // the border width, in texture coordinates
            uniform vec2 pixel;    // one logical pixel, the same
            uniform vec4 tint;     // the accent colour, premultiplied

            float solid(vec2 at) {
                return smoothstep(${(SOLID - FEATHER).toFixed(3)},
                                  ${(SOLID + FEATHER).toFixed(3)},
                                  texture2D(cogl_sampler0, at).a);
            }`;

        const code = `
            vec2 uv = cogl_tex_coord_in[0].st;

            // Sampled on a square rather than a circle, so a square corner
            // stays square.
            float outer = 0.0;
            for (int i = 0; i < ${SAMPLES}; i++) {
                float turn = float(i) * ${(2 * Math.PI / SAMPLES).toFixed(6)};
                vec2 towards = vec2(cos(turn), sin(turn));
                towards /= max(abs(towards.x), abs(towards.y));
                outer = max(outer, solid(uv + spread * towards));
            }

            // Eroded by a pixel, so no gap opens under the window's edge at
            // a fractional scale.
            float inner = solid(uv);
            inner = min(inner, solid(uv + vec2(pixel.x, 0.0)));
            inner = min(inner, solid(uv - vec2(pixel.x, 0.0)));
            inner = min(inner, solid(uv + vec2(0.0, pixel.y)));
            inner = min(inner, solid(uv - vec2(0.0, pixel.y)));

            cogl_color_out = tint * outer * (1.0 - inner);`;

        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
    }
});

export class FocusOutline {
    constructor() {
        this._width = 0;
        this._window = null;
        this._size = null;

        // The widget carries the accent colour from the stylesheet; the copy
        // of the window inside it is what gets drawn.
        this._widget = new St.Widget({
            style_class: 'mantel-focus-outline',
            visible: false,
        });
        this._clone = new Clutter.Clone();
        this._widget.add_child(this._clone);

        this._effect = new Silhouette();
        this._spread = this._effect.get_uniform_location('spread');
        this._pixel = this._effect.get_uniform_location('pixel');
        this._tint = this._effect.get_uniform_location('tint');
        this._widget.add_effect(this._effect);

        global.window_group.add_child(this._widget);
        this._recolour();

        this._widget.connectObject('style-changed', () => this._recolour(), this);
        global.display.connectObject(
            'notify::focus-window', () => this._follow(),
            'restacked', () => this._restack(),
            this);

        this._follow();
    }

    destroy() {
        global.display.disconnectObject(this);
        this._window?.disconnectObject(this);
        this._window = null;

        this._widget.disconnectObject(this);
        this._clone.source = null;
        this._widget.destroy();
        this._widget = null;
        this._clone = null;
        this._effect = null;
    }

    set width(width) {
        this._width = width;
        this._size = null;
        this.sync();
    }

    sync() {
        const window = this._window;
        const actor = window?.get_compositor_private();

        if (!this._width || !actor || !OUTLINED.has(window.get_window_type()) ||
            window.minimized || window.is_fullscreen() ||
            window.is_maximized()) {
            this._clear();
            return;
        }

        if (this._clone.source !== actor)
            this._clone.source = actor;

        // The buffer rect, not the frame: the copy lies exactly over the
        // actor, shadow and all.
        const {x, y, width, height} = window.get_buffer_rect();
        this._widget.set_position(x, y);
        this._widget.set_size(width, height);

        // The shader works in fractions of the window.
        const size = `${width}x${height}`;
        if (size !== this._size) {
            this._size = size;
            this._effect.set_uniform_float(this._spread, 2,
                [this._width / width, this._width / height]);
            this._effect.set_uniform_float(this._pixel, 2, [1 / width, 1 / height]);
        }

        this._restack();
        this._widget.show();
    }

    _clear() {
        this._widget.hide();
        this._clone.source = null;
    }

    // Cogl wants the colour premultiplied.
    _recolour() {
        const colour = this._widget.get_theme_node().get_border_color(St.Side.TOP);
        const alpha = colour.alpha / 255;

        this._effect.set_uniform_float(this._tint, 4, [
            colour.red / 255 * alpha,
            colour.green / 255 * alpha,
            colour.blue / 255 * alpha,
            alpha,
        ]);
        this._effect.queue_repaint();
    }

    _follow() {
        const window = global.display.focus_window;

        if (window !== this._window) {
            this._window?.disconnectObject(this);
            this._window = window;

            window?.connectObject(
                'position-changed', () => this.sync(),
                'size-changed', () => this.sync(),
                'unmanaging', () => {
                    window.disconnectObject(this);
                    this._window = null;
                    this._clear();
                },
                this);
        }

        this.sync();
    }

    // mutter restacks window actors regardless of anything else in the group.
    _restack() {
        const actor = this._window?.get_compositor_private();
        if (!actor || actor.get_parent() !== global.window_group)
            return;

        if (this._widget.get_next_sibling() !== actor)
            global.window_group.set_child_below_sibling(this._widget, actor);
    }
}
