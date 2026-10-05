export * from './contracts/index';
export * from './importers/index';
export * from './recommender/index';
export * from './recommender/policy';
export * from './demo/runtime';
export * from './demo/fixture';
export * from './indexer/index';
export * from './openspec/index';
export * from './openspec/bundle';
export { startUiServer } from './ui/server';
export {
  createPlugMcpServer,
  installMcp,
  mcpConfigFiles,
  runMcpServer,
} from './mcp/server';
export type { McpIde, McpInstall } from './mcp/server';
export type { UiServerOptions } from './ui/server';
export { flightInput, keys as flightKeys, coldKey } from './demo/flight';
