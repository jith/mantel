// The General page against the real GTK and libadwaita, as prefs.test.js
// runs the Shortcuts page: settings in memory, nothing shown.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import System from 'system';

Adw.init();

let failures = 0;
const expect = (label, ok, detail = '') => {
    if (!ok)
        failures++;
    print(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};

const here = Gio.File.new_for_path(System.programPath).get_parent().get_parent();
const source = Gio.SettingsSchemaSource.new_from_directory(
    here.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
globalThis.mantelSettings = new Gio.Settings({
    settings_schema: source.lookup('org.gnome.shell.extensions.mantel', false),
    backend: Gio.memory_settings_backend_new(),
});
const settings = globalThis.mantelSettings;

const {default: MantelPreferences} = await import('./.general-under-test.js');
const window = new Adw.PreferencesWindow();
new MantelPreferences().fillPreferencesWindow(window);

const rows = [];
const walk = widget => {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Adw.PreferencesRow)
            rows.push(child);
        walk(child);
    }
};
walk(window);
const row = title => rows.find(r => r.title === title);

print('\nthe page  (a switch per feature, the layout under tiling)');
for (const [key, title] of [['workspace-numbers', 'Workspace numbers'],
    ['autohide', 'Auto-hide the top bar'], ['auto-tile', 'Tile windows as they open']]) {
    row(title).active = !settings.get_boolean(key);
    expect(`"${title}" switches ${key}`, row(title).active === settings.get_boolean(key));
    settings.reset(key);
}
const hover = row('Focus follows the mouse');
expect('focus follows the mouse by default', hover.active && settings.get_boolean('focus-follows-mouse'));
hover.active = false;
expect('and can be switched off', !settings.get_boolean('focus-follows-mouse'));
settings.reset('focus-follows-mouse');
expect('greyed out while tiling is off', !hover.is_sensitive());
settings.set_boolean('auto-tile', true);
expect('and usable once it is on', hover.is_sensitive());
settings.set_int('gap', 10);
expect('the gap is shown as set', row('Gap between windows').value === 10);
expect('the Shortcuts page is there too', !!row('Float the focused window'));

window.close();
print(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
System.exit(failures ? 1 : 0);
