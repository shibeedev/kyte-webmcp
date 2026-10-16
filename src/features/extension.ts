/** Extension-side halves of the features (service worker). */
import type { Feature } from '../extension/background/types.ts';
import { tabsFeature } from './tabs/handler.ts';
import { navigationFeature } from './navigation/handler.ts';
import { snapshotFeature } from './snapshot/handler.ts';
import { inputFeature } from './input/handler.ts';
import { screenshotFeature } from './screenshot/handler.ts';
import { scriptFeature } from './script/handler.ts';
import { browserFeature } from './browser/handler.ts';
import { videoFeature } from './video/handler.ts';
import { consoleFeature } from './console/handler.ts';
import { networkFeature } from './network/handler.ts';
import { performanceFeature } from './performance/handler.ts';
import { elementsFeature } from './elements/handler.ts';
import { applicationFeature } from './application/handler.ts';
import { emulationFeature } from './emulation/handler.ts';
import { issuesMemoryFeature } from './issues-memory/handler.ts';
import { cdpFeature } from './cdp/handler.ts';
import { devtoolsPanelFeature } from './devtools-panel/handler.ts';
import { webmcpFeature } from './webmcp/handler.ts';

export const extensionFeatures: Feature[] = [
  tabsFeature,
  navigationFeature,
  snapshotFeature,
  inputFeature,
  screenshotFeature,
  scriptFeature,
  browserFeature,
  videoFeature,
  consoleFeature,
  networkFeature,
  performanceFeature,
  elementsFeature,
  applicationFeature,
  emulationFeature,
  issuesMemoryFeature,
  cdpFeature,
  devtoolsPanelFeature,
  webmcpFeature,
];
