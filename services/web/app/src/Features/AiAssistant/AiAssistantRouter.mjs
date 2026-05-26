import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import AiAssistantController from './AiAssistantController.mjs'

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

    // Per-project session
    webRouter.get(
      '/project/:Project_id/ai-assistant/stream',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.stream
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/message',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.sendMessage
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/stop',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.stop
    )
    webRouter.get(
      '/project/:Project_id/ai-assistant/files',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.files
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/permission-response',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.permissionResponse
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/revert-file',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.revertFile
    )

    // Session management
    webRouter.get(
      '/project/:Project_id/ai-assistant/sessions',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.listSessions
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/sessions',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.createSession
    )
    webRouter.post(
      '/project/:Project_id/ai-assistant/sessions/:sessionId/rename',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.renameSession
    )
    webRouter.delete(
      '/project/:Project_id/ai-assistant/sessions/:sessionId',
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistantController.deleteSession
    )
  },
}
