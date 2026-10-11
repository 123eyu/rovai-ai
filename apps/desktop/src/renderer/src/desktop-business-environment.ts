import { createProjectRegistry, legacyProjectPaths } from './project-registry'
import type { BusinessEnvironment } from './business-environment'
import { desktopThreadClient } from './desktop-camp-client'
import { desktopFilePreviewApi } from './desktop-file-preview-api'

export const desktopBusinessEnvironment: BusinessEnvironment = {
  client: desktopThreadClient,
  projects: createProjectRegistry((method, params) => window.rovai.request(method, params), async () => legacyProjectPaths(await window.rovai.navigationPreferences.get())),
  files: desktopFilePreviewApi,
  get preferences() { return window.rovai },
  get desktop() { return window.rovai },
  selectWorkspaceDirectory: () => window.rovai.selectWorkspaceDirectory(),
  revealProjectDirectory: path => window.rovai.revealProjectDirectory(path)
}
