/**
 * Registry of every tool contract. Adding a feature = adding its spec here,
 * its extension handlers in ./extension.ts and (if any) its bridge parts in ./bridge.ts.
 */
import type { ToolSpec } from '../shared/tool-spec.ts';
import { connectionTools } from './connection/spec.ts';
import { tabsTools } from './tabs/spec.ts';
import { navigationTools } from './navigation/spec.ts';
import { snapshotTools } from './snapshot/spec.ts';
import { inputTools } from './input/spec.ts';
import { screenshotTools } from './screenshot/spec.ts';
import { scriptTools } from './script/spec.ts';
import { browserTools } from './browser/spec.ts';
import { videoTools } from './video/spec.ts';
import { consoleTools } from './console/spec.ts';
import { networkTools } from './network/spec.ts';
import { performanceTools } from './performance/spec.ts';
import { elementsTools } from './elements/spec.ts';
import { applicationTools } from './application/spec.ts';
import { emulationTools } from './emulation/spec.ts';
import { issuesMemoryTools } from './issues-memory/spec.ts';
import { cdpTools } from './cdp/spec.ts';
import { devtoolsPanelTools } from './devtools-panel/spec.ts';
import { webmcpTools } from './webmcp/spec.ts';

export const allToolSpecs: ToolSpec[] = [
  ...connectionTools,
  ...tabsTools,
  ...navigationTools,
  ...snapshotTools,
  ...inputTools,
  ...screenshotTools,
  ...scriptTools,
  ...browserTools,
  ...videoTools,
  ...consoleTools,
  ...networkTools,
  ...performanceTools,
  ...elementsTools,
  ...applicationTools,
  ...emulationTools,
  ...issuesMemoryTools,
  ...cdpTools,
  ...devtoolsPanelTools,
  ...webmcpTools,
];

export const specByName = new Map(allToolSpecs.map((s) => [s.name, s]));
