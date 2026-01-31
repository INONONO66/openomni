// Export namespaces
export { Auth } from "./auth"
export { Provider } from "./provider"

// Re-export key OAuth functions for convenience
export {
  // Anthropic OAuth
  authorize,
  exchange,
  refreshToken,
  createApiKey,
  // OpenAI OAuth
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  extractAccountId,
  startOAuthServer,
  stopOAuthServer,
  waitForOAuthCallback,
  initiateDeviceAuth,
  pollDeviceAuth,
  // PKCE utilities
  generatePKCE,
  generateState,
} from "./auth"

// Re-export provider functions
export {
  createAnthropicProvider,
  createOpenAIProvider,
  getAnthropicModels,
  getOpenAIModels,
  getProvider,
  listModels,
  listProviders,
} from "./provider"
