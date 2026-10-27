// Portable WebHID simulation: no private fixtures or hardware.
import { test } from 'node:test';
import * as synthetic from '../test-support/synthetic.js';
import { deviceSuite } from '../test-support/device-suite.js';
deviceSuite({ ...synthetic, fixtureTest: (name, fn) => test(name, async t => { await synthetic.loadTables(); return fn(t); }) });
