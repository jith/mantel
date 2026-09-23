// Starting and stopping features: from their settings, around the lock
// screen, and with one of them throwing. The features are stand-ins that
// record what was asked of them.
import {Settings} from './stubs.mjs';

let failures = 0;
const expect = (label, ok, detail = '') => {
    if (!ok)
        failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${detail}`);
};

const running = new Set();
const broken = {};
const feature = name => class {
    enable() {
        running.add(name);
        if (broken[name])
            throw new Error(name);
    }

    disable() {
        running.delete(name);
        if (broken[name] === 'both')
            throw new Error(name);
    }
};

const settings = new Settings({'workspace-numbers': true, 'autohide': true, 'auto-tile': true});
const sessionMode = {
    isLocked: false,
    connectObject(_signal, handler) { this.updated = handler; },
    disconnectObject() { this.updated = null; },
};
globalThis.extensionStubs = {
    Main: {sessionMode},
    Extension: class { getSettings() { return settings; } },
    WorkspaceNumbers: feature('numbers'),
    PanelAutohide: feature('autohide'),
    AutoTile: feature('tiling'),
};
const {default: MantelExtension} = await import('./.extension-under-test.mjs');
const state = () => [...running].sort().join(',');

console.log('\nfeatures  (each from its own setting)');
const extension = new MantelExtension();
extension.enable();
expect('all three start', state() === 'autohide,numbers,tiling', state());
settings.set_boolean('autohide', false);
expect('one switched off stops alone', state() === 'numbers,tiling', state());
settings.set_boolean('autohide', true);

console.log('\nthe lock screen  (only the layout stays)');
sessionMode.isLocked = true;
sessionMode.updated();
expect('locked, tiling alone runs', state() === 'tiling', state());
sessionMode.isLocked = false;
sessionMode.updated();
expect('unlocked, the others are back', state() === 'autohide,numbers,tiling', state());

console.log('\na feature that throws  (the others carry on)');
const error = console.error;
const errors = [];
console.error = message => errors.push(message);
settings.set_boolean('autohide', false);
broken.autohide = 'both';
settings.set_boolean('autohide', true);
expect('it is unwound', !running.has('autohide'), state());
expect('the others still run', state() === 'numbers,tiling', state());
expect('and both failures are logged', errors.length === 2, errors.join('; '));
settings.set_boolean('autohide', false);
broken.numbers = 'both';
extension.disable();
expect('disable stops the rest past one that throws', state() === '', state());
console.error = error;

console.log(`\n${failures === 0 ? 'all assertions passed' : `${failures} FAILURES`}\n`);
process.exit(failures ? 1 : 0);
