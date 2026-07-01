/** @fiberlsp/client — wallet-side SDK: discover LSP providers and buy inbound liquidity. */
export {
  LspClient,
  LspApiError,
  type LspClientConfig,
  type HttpFetch,
  type BuyInboundParams,
  type WaitOpts,
} from "./LspClient.js";
export {
  discover,
  fetchRegistry,
  type Registry,
  type RegistryProvider,
  type DiscoveredProvider,
} from "./discover.js";
