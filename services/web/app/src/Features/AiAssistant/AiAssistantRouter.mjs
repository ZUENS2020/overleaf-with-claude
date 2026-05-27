import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import AiAssistantController from './AiAssistantController.mjs'
import AiAssistantSettingsController from './AiAssistantSettingsController.mjs'

export default {
  apply(webRouter) {
    // OAuth (per-user, not per-project)
    webRouter.post(
      '/ai-assistant/oauth/start',
      AuthenticationController.requireLogin(),
      AiAssistantController.oauthStart
    )
    webRouter.post(
      '/ai-assistant/oauth/exchange',
      AuthenticationController.requireLogin(),
      AiAssistantController.oauthExchange
    )
    webRouter.get(
      '/ai-assistant/oauth/status',
      AuthenticationController.requireLogin(),
      AiAssistantController.oauthStatus
    )
    webRouter.post(
      '/ai-assistant/oauth/disconnect',
      AuthenticationController.requireLogin(),
      AiAssistantController.oauthDisconnect
    )

    // User preferences (per-user, not per-project)
    webRouter.get(
      '/ai-assistant/preferences',
      AuthenticationController.requireLogin(),
      AiAssistantController.getPreferences
    )
    webRouter.put(
      '/ai-assistant/preferences',
      AuthenticationController.requireLogin(),
      AiAssistantController.updatePreferences
    )

    // Provider management (per-user)
    webRouter.get(
      '/ai-assistant/connection',
      AuthenticationController.requireLogin(),
      AiAssistantSettingsController.getConnection
    )
    webRouter.get(
      '/ai-assistant/providers',
      AuthenticationController.requireLogin(),
      AiAssistantSettingsController.listProviders
    )
    webRouter.post(
      '/ai-assistant/providers',
      AuthenticationController.requireLogin(),
      AiAssistantSettingsController.createProvider
    )
    webRouter.put(
      '/ai-assistant/providers/:id',
      AuthenticationController.requireLogin(),
      AiAssistantSettingsController.updateProvider
    )
    webRouter.delete(
      '/ai-assistant/providers/:id',
      AuthenticationController.requireLogin(),
      AiAssistantSettingsController.deleteProvider
    )
    webRouter.post(
      '/ai-assistant/providers/:id/activate',
      AuthenticationController.requireLogin(),
      AiAssistantSettingsController.activateProvider
    )

    // Per-project — require write access
    const writeAuth = AuthorizationMiddleware.ensureUserCanWriteProjectContent
    webRouter.get(
      '/project/:Project_id/ai-assistant/stream',
      writeAuth,
      AiAssistantController.stream
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/message',
      writeAuth,
      AiAssistantController.sendMessage
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/stop',
      writeAuth,
      AiAssistantController.stop
    )
    webRouter.get(
      '/project/:Project_id/ai-assistant/files',
      writeAuth,
      AiAssistantController.files
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/permission-response',
      writeAuth,
      AiAssistantController.permissionResponse
    )
    // Session management
    webRouter.get(
      '/project/:Project_id/ai-assistant/sessions',
      writeAuth,
      AiAssistantController.listSessions
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/sessions',
      writeAuth,
      AiAssistantController.createSession
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/sessions/:sessionId/rename',
      writeAuth,
      AiAssistantController.renameSession
    )
    webRouter.delete(
      '/project/:Project_id/ai-assistant/sessions/:sessionId',
      writeAuth,
      AiAssistantController.deleteSession
    )
    webRouter.get(
      '/project/:Project_id/ai-assistant/sessions/:sessionId/messages',
      writeAuth,
      AiAssistantController.getSessionMessages
    )
    webRouter.put(
      '/project/:Project_id/ai-assistant/sessions/:sessionId/messages',
      writeAuth,
      AiAssistantController.saveSessionMessages
    )
  },
}