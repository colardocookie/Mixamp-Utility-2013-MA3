// Optional replay with locally generated firmware-derived inputs.
import * as core from '../ma3-core.js';
import { MixAmp } from '../ma3-device.js';
import { fixtureTest, golden, tables } from '../test-support/fixtures.js';
import { deviceSuite } from '../test-support/device-suite.js';
deviceSuite({ core, MixAmp, fixtureTest, golden, tables, extended: false, portableTest: () => {} });
