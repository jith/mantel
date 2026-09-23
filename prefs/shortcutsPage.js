// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Shortcuts page: every chord Mantel binds, changed by pressing the new
// chord. A chord something else uses is marked and confirmed first; only
// Mantel's own settings are ever written.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BORROWED_SHORTCUTS, SHORTCUT_GROUPS, unbind} from '../shortcuts.js';

// GNOME's shortcuts and those of extensions installed for everyone. Custom
// shortcuts are one relocatable schema each, read separately.
const OTHER_SCHEMAS = /^org\.gnome\.(.*keybindings|settings-daemon\.plugins\.media-keys|shell\.extensions\..*)$/;
const CUSTOM_LIST = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
const OWN = 'org.gnome.shell.extensions.mantel';

// Keys that make a shortcut with no modifier held: function keys, hardware
// keys (XF86…) and Print.
function standalone(keyval) {
    return (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) ||
        keyval >= 0x1008ff00 || keyval === Gdk.KEY_Print;
}

// One chord however it is spelled: mutter binds by physical key, so only the
// keycode says Super+Shift+minus and Super+Shift+underscore are the same.
function chordOf(display, accelerator) {
    if (!accelerator)
        return null;

    const [ok, keyval, keycodes, mods] =
        Gtk.accelerator_parse_with_keycode(accelerator, display);
    if (!ok || !keyval || (!(mods & ~Gdk.ModifierType.SHIFT_MASK) && !standalone(keyval)))
        return null;

    return `${keycodes?.[0] ?? keyval}:${mods}`;
}

// Every chord something other than Mantel has while auto-tiling runs, which
// is when Mantel's are bound, with a name to show.
function otherShortcuts(display) {
    const source = Gio.SettingsSchemaSource.get_default();
    const found = [];
    const add = (accelerator, name) => {
        const chord = chordOf(display, accelerator);
        if (chord)
            found.push({chord, name});
    };

    const [ids] = source.list_schemas(true);
    for (const id of ids) {
        if (id === OWN || !OTHER_SCHEMAS.test(id))
            continue;

        const schema = source.lookup(id, true);
        const settings = new Gio.Settings({settings_schema: schema});
        for (const key of schema.list_keys()) {
            const schemaKey = schema.get_key(key);
            if (schemaKey.get_value_type().dup_string() !== 'as')
                continue;

            const accelerators = settings.get_strv(key);
            const lent = BORROWED_SHORTCUTS[id]?.includes(key) ? unbind(key)(accelerators) : null;
            for (const accelerator of lent ?? accelerators)
                add(accelerator, schemaKey.get_summary() || key);
        }
    }

    // A malformed path aborts the process rather than throwing.
    const custom = source.lookup(CUSTOM, true);
    if (custom && source.lookup(CUSTOM_LIST, true)) {
        const list = new Gio.Settings({schema_id: CUSTOM_LIST});
        for (const path of list.get_strv('custom-keybindings')) {
            if (!path.startsWith('/') || !path.endsWith('/'))
                continue;

            const shortcut = new Gio.Settings({settings_schema: custom, path});
            add(shortcut.get_string('binding'), shortcut.get_string('name'));
        }
    }

    return found;
}

export function buildShortcutsPage(settings, window) {
    const page = new Adw.PreferencesPage({
        title: _('Shortcuts'),
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    });
    const display = window.get_display();
    const schema = settings.settings_schema;
    const titleOf = key => _(schema.get_key(key).get_summary());
    let others = otherShortcuts(display);

    page.add(new Adw.PreferencesGroup({
        description: _('These work while windows are being tiled. Click one to change it. ' +
            'A shortcut something else already uses is marked; setting one here never changes anyone else’s.'),
    }));

    // Who else holds these chords: the desktop by name, Mantel by key.
    const holders = (key, accelerators) => {
        const chords = new Set(accelerators.map(a => chordOf(display, a)).filter(Boolean));
        const outside = [...new Set(others
            .filter(other => chords.has(other.chord))
            .map(other => other.name))];
        const mantel = [...rows.keys()].filter(other => other !== key &&
            settings.get_strv(other).some(a => chords.has(chordOf(display, a))));
        return {chords, outside, mantel};
    };

    const rows = new Map();
    for (const [group, keys] of SHORTCUT_GROUPS) {
        const section = new Adw.PreferencesGroup({title: _(group)});
        page.add(section);

        for (const key of keys) {
            const row = new Adw.ActionRow({
                title: titleOf(key),
                tooltip_text: _(schema.get_key(key).get_description()),
                activatable: true,
            });
            const warning = new Gtk.Image({
                icon_name: 'dialog-warning-symbolic',
                css_classes: ['warning'],
                visible: false,
            });
            const label = new Adw.ShortcutLabel({
                disabled_text: _('Disabled'),
                valign: Gtk.Align.CENTER,
            });
            const reset = new Gtk.Button({
                icon_name: 'edit-undo-symbolic',
                tooltip_text: _('Reset to Default'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });

            row.add_prefix(warning);
            row.add_suffix(label);
            row.add_suffix(reset);
            row.connect('activated', () => capture(key));
            reset.connect('clicked', () => settings.reset(key));

            section.add(row);
            rows.set(key, {row, warning, label, reset});
        }
    }

    const resetAll = new Adw.ButtonRow({title: _('Reset All Shortcuts')});
    resetAll.connect('activated', () => {
        const confirm = new Adw.AlertDialog({
            heading: _('Reset All Shortcuts?'),
            body: _('Every Mantel shortcut goes back to its default.'),
        });
        confirm.add_response('cancel', _('Cancel'));
        confirm.add_response('reset', _('Reset'));
        confirm.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        confirm.connect('response', (_dialog, response) => {
            if (response === 'reset')
                rows.forEach((_row, key) => settings.reset(key));
        });
        confirm.present(window);
    });
    const tail = new Adw.PreferencesGroup();
    tail.add(resetAll);
    page.add(tail);

    const sync = () => {
        for (const [key, {row, warning, label, reset}] of rows) {
            const accelerators = settings.get_strv(key);
            label.accelerator = accelerators.join(' ');
            reset.visible = settings.get_user_value(key) !== null;

            const {outside, mantel} = holders(key, accelerators);
            const names = [...outside, ...mantel.map(other => `Mantel: ${titleOf(other)}`)];
            warning.visible = names.length > 0;
            row.subtitle = names.length
                ? _('Also used by %s').replace('%s', names.join(', '))
                : '';
        }
    };

    // Asks first when something else has the chord. Mantel's other
    // shortcuts give it up; anyone else's are left alone.
    const assign = (key, accelerators) => {
        const {chords, outside, mantel} = holders(key, accelerators);
        if (!outside.length && !mantel.length) {
            settings.set_strv(key, accelerators);
            return;
        }

        const [, keyval, mods] = Gtk.accelerator_parse(accelerators[0]);
        let body = _('%s is already used by %s.')
            .replace('%s', Gtk.accelerator_get_label(keyval, mods))
            .replace('%s', [...outside, ...mantel.map(titleOf)].join(', '));
        if (mantel.length)
            body += ` ${_('Mantel’s other shortcut gives it up.')}`;
        if (outside.length)
            body += ` ${_('Mantel leaves that one as it is, so while both have it, which one runs is not predictable.')}`;

        const confirm = new Adw.AlertDialog({heading: _('Shortcut Already in Use'), body});
        confirm.add_response('cancel', _('Cancel'));
        confirm.add_response('set', _('Set Anyway'));
        confirm.set_response_appearance('set', outside.length
            ? Adw.ResponseAppearance.DESTRUCTIVE
            : Adw.ResponseAppearance.SUGGESTED);
        confirm.connect('response', (_dialog, response) => {
            if (response !== 'set')
                return;

            for (const other of mantel) {
                settings.set_strv(other, settings.get_strv(other)
                    .filter(a => !chords.has(chordOf(display, a))));
            }
            settings.set_strv(key, accelerators);
        });
        confirm.present(window);
    };

    const capture = key => {
        others = otherShortcuts(display);

        const dialog = new Adw.AlertDialog({
            heading: _('Set Shortcut'),
            body: _('Press the new shortcut for “%s”.\nEsc cancels, Backspace disables it.')
                .replace('%s', titleOf(key)),
        });
        dialog.add_response('cancel', _('Cancel'));

        const keys = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        keys.connect('key-pressed', (controller, keyval, keycode, state) => {
            const event = controller.get_current_event();
            if (event?.is_modifier())
                return Gdk.EVENT_STOP;

            const mask = state & Gtk.accelerator_get_default_mod_mask() &
                ~Gdk.ModifierType.LOCK_MASK;

            if (!mask && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }

            if (!mask && keyval === Gdk.KEY_BackSpace) {
                dialog.close();
                assign(key, []);
                return Gdk.EVENT_STOP;
            }

            // Stored as the key is labelled, not as Shift turns it, like the
            // defaults.
            const [translated, unshifted] =
                display.translate_key(keycode, 0, event?.get_layout() ?? 0);
            const base = Gdk.keyval_to_lower(translated ? unshifted : keyval);

            if ((!(mask & ~Gdk.ModifierType.SHIFT_MASK) && !standalone(base)) ||
                !Gtk.accelerator_valid(base, mask)) {
                dialog.body = _('%s cannot be a shortcut by itself. Hold Super, Ctrl or Alt with it.')
                    .replace('%s', Gtk.accelerator_get_label(base, mask));
                return Gdk.EVENT_STOP;
            }

            dialog.close();
            assign(key, [Gtk.accelerator_name(base, mask)]);
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);

        // Otherwise the shell acts on a chord it has before the dialog sees
        // it, as GNOME Settings also prevents.
        const toplevel = window.get_surface();
        toplevel?.inhibit_system_shortcuts(null);
        dialog.connect('closed', () => toplevel?.restore_system_shortcuts());

        dialog.present(window);
    };

    // Dropped with the window, which the preferences process outlives.
    const changed = settings.connect('changed', () => sync());
    window.connect('close-request', () => {
        settings.disconnect(changed);
        return false;
    });

    sync();
    return page;
}
