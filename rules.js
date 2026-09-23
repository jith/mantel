// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which windows auto-tiling lays out, and why the others float.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

// Always floated: the portal only shows dialogs, and wl-copy opens a window
// for a moment on every copy.
const FLOAT_CLASSES = /^(xdg-desktop-portal-.*|io\.github\.bugaevc\.wl-clipboard)$/i;
const FLOAT_TITLES = /picture.?in.?picture|is sharing/i;
const PIP_TITLES = /picture.?in.?picture/i;
const FLOAT_ROLES = /pop-up|task_dialog/;

// File pickers these apps open themselves rather than through the portal.
const FILE_DIALOG_APPS = /^(org\.gnome\.Nautilus|sublime_text|DesktopEditors)$/i;
const FILE_DIALOG_TITLES =
    /^(Open.*Files?|Open Folder.*|Save.*Files?|Save.*As|Save|All Files|.*wants to (open|save).*|Choose.*)$/i;

// What an app opens for the user, as against docks, menus and splash screens.
const APP_TYPES = new Set([Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY]);

// mutter answers [set, width, height], and [false, 0, 0] for no limit.
export function minSize(window) {
    const [, width, height] = window.get_min_size();
    return [width, height];
}

function maxSize(window) {
    const [, width, height] = window.get_max_size();
    return [width || Infinity, height || Infinity];
}

// A float-apps entry names an app ID, or a prefix when it ends in *.
function listed(entry, id) {
    const want = entry.toLowerCase();
    const have = id.toLowerCase();
    return want.endsWith('*') ? have.startsWith(want.slice(0, -1)) : have === want;
}

// Whether a window can be laid out at all. Nothing overrides this.
export function tileable(window) {
    if (window.get_monitor() < 0 ||
        window.get_window_type() !== Meta.WindowType.NORMAL ||
        window.is_skip_taskbar() ||
        window.is_attached_dialog() ||
        window.get_transient_for() !== null ||
        window.is_fullscreen())
        return false;

    // Only a floating window may be on every workspace, except on a secondary
    // monitor while workspaces are only on the primary, where every window is.
    if (window.is_on_all_workspaces() &&
        (window.is_on_primary_monitor() || !Meta.prefs_get_workspaces_only_on_primary()))
        return false;

    // Maximized, a window cannot be resized until it is unmaximized.
    return window.is_maximized() || (window.allows_move() && window.allows_resize());
}

// Why a window floats as it arrives, or null. An app window the layout cannot
// take floats, unless it is attached to its parent, or fullscreen and let in
// once it leaves fullscreen.
export function floatRule(window, floatApps) {
    if (!tileable(window)) {
        return window.get_monitor() < 0 || window.is_skip_taskbar() ||
            window.is_attached_dialog() || window.is_fullscreen() ||
            !APP_TYPES.has(window.get_window_type())
            ? null : 'the layout cannot take it';
    }

    const [maxWidth, maxHeight] = maxSize(window);
    const area = window.get_work_area_current_monitor();
    if (maxWidth < area.width || maxHeight < area.height)
        return `it cannot grow past ${maxWidth}x${maxHeight}`;

    const role = window.get_role() ?? '';
    if (FLOAT_ROLES.test(role))
        return `its role is ${role}`;

    // Its app ID, and the desktop file the shell matched it to, which is what
    // a snap or Flatpak is installed as.
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const id = [window.get_wm_class(), app?.get_id().replace(/\.desktop$/, '')]
        .find(candidate => candidate &&
            (FLOAT_CLASSES.test(candidate) || floatApps.some(entry => listed(entry, candidate))));
    if (id)
        return `${id} always floats`;

    const title = window.get_title() ?? '';
    if (FLOAT_TITLES.test(title) ||
        (FILE_DIALOG_APPS.test(window.get_wm_class() ?? '') && FILE_DIALOG_TITLES.test(title)))
        return 'its title marks it as a picker or overlay';

    return null;
}

// Picture-in-picture stays on every workspace.
export const followsWorkspaces = window => PIP_TITLES.test(window.get_title() ?? '');
