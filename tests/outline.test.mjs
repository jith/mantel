import {FocusOutline} from './.outline-under-test.mjs';
import {Clutter, Meta, SHADOW, Window, accent, focus, global, raise, restacks, stack} from './outline-stubs.mjs';

let failures = 0;
const expect = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};

const outline = new FocusOutline();
const widget = stack().find(actor => actor instanceof Object && actor.children);
const effect = widget.effects[0];
const clone = widget.children[0];
const box = () => `${widget.width}x${widget.height}+${widget.x}+${widget.y}`;
const uniform = name => (effect.uniforms.get(name) ?? []).map(v => v.toFixed(5)).join(',');

console.log('\nnothing to outline yet');
expect('hidden with no focused window', !widget.visible, `visible=${widget.visible}`);
expect('the shape is built once', effect.snippets.length === 1,
    `${effect.snippets.length} snippets`);
expect('and samples the window it is given',
    effect.snippets[0].code.includes('cogl_tex_coord_in[0]') &&
    effect.snippets[0].declarations.includes('cogl_sampler0'),
    'reads the texture');

// The accent colour comes from the stylesheet, and reaches the shader
// premultiplied, which for an opaque colour leaves it as it was.
expect('painted in the accent colour',
    uniform('tint') === '0.82745,0.27451,0.08235,1.00000', uniform('tint'));

// The floated terminal from the screenshot: 1012x734 at 210,62, which at
// 125% puts both of its leading edges on half a physical pixel.
const floating = new Window({x: 210, y: 62, width: 1012, height: 734});
focus(floating);
expect('hidden while the width is zero', !widget.visible, `visible=${widget.visible}`);
expect('and holding no copy of the window', clone.source === null, `source=${clone.source}`);

console.log('\na focused window  (copied, and stacked under the window)');
outline.width = 2;
expect('shown', widget.visible, `visible=${widget.visible}`);
expect('the copy is of the focused window', clone.source === floating.actor,
    `source=${clone.source === floating.actor}`);
// The buffer, not the frame: the copy has to lie over the actor exactly, and
// the actor carries the shadow the client drew around itself.
expect('laid over the whole actor, shadow and all',
    box() === `${1012 + 2 * SHADOW}x${734 + 2 * SHADOW}+${210 - SHADOW}+${62 - SHADOW}`, box());
expect('stacked directly below its window',
    widget.get_next_sibling() === floating.actor, `next=${stack().indexOf(widget.get_next_sibling())}`);

// Two pixels of a 1064x786 buffer, as fractions of it: what the shader
// widens the window's own shape by.
expect('widened by the border width',
    uniform('spread') === `${(2 / 1064).toFixed(5)},${(2 / 786).toFixed(5)}`, uniform('spread'));
expect('and pulled back in by one pixel',
    uniform('pixel') === `${(1 / 1064).toFixed(5)},${(1 / 786).toFixed(5)}`, uniform('pixel'));

console.log('\nfollowing the window  (cheaply, since this runs on every step of a drag)');
const set = effect.sets;
floating.rect = {x: 300, y: 100, width: 1012, height: 734};
floating.emit('position-changed');
expect('moves with it',
    box() === `${1012 + 2 * SHADOW}x${734 + 2 * SHADOW}+${300 - SHADOW}+${100 - SHADOW}`, box());
expect('without measuring it again', effect.sets === set, `${effect.sets - set} uniforms set`);
const moved = restacks.count;
global.display.emit('restacked');
expect('nor restacked when already in place', restacks.count === moved,
    `${restacks.count - moved} restacks`);

floating.rect = {x: 300, y: 100, width: 800, height: 600};
floating.emit('size-changed');
expect('a resize is measured again',
    uniform('spread') === `${(2 / (800 + 2 * SHADOW)).toFixed(5)},${(2 / (600 + 2 * SHADOW)).toFixed(5)}`,
    uniform('spread'));

// mutter raises the window's actor over another, leaving the outline behind.
const other = new Window({x: 0, y: 0, width: 10, height: 10});
raise(floating.actor);
global.display.emit('restacked');
expect('put back under a raised window',
    widget.get_next_sibling() === floating.actor && restacks.count === moved + 1,
    `${restacks.count - moved} restack`);

console.log('\nwhen the accent changes');
const repaints = effect.repaints;
accent.red = 0; accent.green = 128; accent.blue = 255;
widget.emit('style-changed');
expect('the colour is read again',
    uniform('tint') === '0.00000,0.50196,1.00000,1.00000', uniform('tint'));
expect('and the outline redrawn', effect.repaints > repaints,
    `${effect.repaints - repaints} repaints`);

console.log('\nwhere nothing is drawn');
floating.maximizedHorizontally = floating.maximizedVertically = true;
floating.emit('size-changed');
expect('maximized', !widget.visible, `visible=${widget.visible}`);
expect('and the copy let go of', clone.source === null, `source=${clone.source}`);
floating.maximizedVertically = false;
floating.emit('size-changed');
expect('half maximized is still outlined', widget.visible, `visible=${widget.visible}`);
floating.maximizedHorizontally = false;
floating.fullscreen = true;
floating.emit('size-changed');
expect('fullscreen', !widget.visible, `visible=${widget.visible}`);
floating.fullscreen = false;
floating.emit('size-changed');

const menu = new Window({x: 0, y: 0, width: 100, height: 100},
    {type: Meta.WindowType.POPUP_MENU});
focus(menu);
expect('a window type that is not outlined', !widget.visible, `visible=${widget.visible}`);

const dialog = new Window({x: 10, y: 10, width: 100, height: 100},
    {type: Meta.WindowType.DIALOG});
focus(dialog);
expect('a dialog is', widget.visible, `visible=${widget.visible}`);

console.log('\nletting go of windows');
expect('the window focus left is let go', floating.handlers.size === 0,
    `${floating.handlers.size} handlers left`);
expect('and so is the menu', menu.handlers.size === 0, `${menu.handlers.size} handlers left`);

dialog.emit('unmanaging');
expect('an unmanaged window is let go at once', dialog.handlers.size === 0,
    `${dialog.handlers.size} handlers left`);
expect('its outline hidden', !widget.visible, `visible=${widget.visible}`);
expect('and its copy dropped before the actor goes', clone.source === null,
    `source=${clone.source}`);

focus(floating);
outline.destroy();
expect('destroy lets go of the focused window', floating.handlers.size === 0,
    `${floating.handlers.size} handlers left`);
expect('and of the display', global.display.handlers.size === 0,
    `${global.display.handlers.size} handlers left`);
expect('and of the widget', widget.handlers.size === 0,
    `${widget.handlers.size} handlers left`);
expect('and takes the widget out of the group', widget.destroyed && !stack().includes(widget),
    `destroyed=${widget.destroyed}`);
expect('and holds no copy of a window afterwards', clone.source === null,
    `source=${clone.source}`);

console.log(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
process.exit(failures ? 1 : 0);
