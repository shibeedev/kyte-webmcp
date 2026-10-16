/** Bridge-side halves of the features (Node only). */
import type { BridgeContext, BridgeFeature } from '../bridge/types.ts';
import { connectionBridge } from './connection/bridge.ts';
import { promptsBridge } from './prompts/prompts.ts';
import { transcriberServices } from './video/transcriber.ts';
import { traceServices } from './performance/trace-analyzer.ts';
import { fullDevtoolsServices } from './full-devtools/services.ts';

export const bridgeFeatures: BridgeFeature[] = [
  connectionBridge,
  promptsBridge,
  { name: 'video', services: () => transcriberServices() },
  { name: 'performance', services: () => traceServices() },
  { name: 'full-devtools', services: (ctx: BridgeContext) => fullDevtoolsServices(ctx) },
];
