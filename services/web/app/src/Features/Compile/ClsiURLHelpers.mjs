import { zz } from '@overleaf/validation-tools'
import Settings from '@overleaf/settings'

// Tolerate a scheme-less / port-less host in
// Settings.apis.clsi.downloadHost / Settings.apis.clsi.url. The
// shipped clsi-nginx container's server block listens on 8080, but
// `new URL('clsi-nginx')` defaults to port 80 (where nginx's stock
// welcome server is — every output fetch then 404s). Prepend `http://`
// if missing and attach :8080 when the host is the bare clsi-nginx
// service name with no explicit port.
function toAbsoluteUrl(host) {
  let v = /^[a-z]+:\/\//i.test(host) ? host : 'http://' + host
  // The shipped clsi-nginx listens on 8080. But settings.defaults.js
  // forces `:80` when CLSI_LB_IP is set (a SaaS-style load-balancer
  // assumption) and otherwise builds `http://${DOWNLOAD_HOST}:8080`,
  // so depending on which env is set we get the wrong port or the
  // right one. Normalize: any port (or missing port) on the
  // clsi-nginx host is rewritten to 8080.
  v = v.replace(/^(https?:\/\/clsi-nginx)(?::\d+)?(\/|$)/, '$1:8080$2')
  return v
}

// Build zod schema once and use it below.
const schema = {
  compileBackendClass: zz.compileBackendClass(),
  optionalClsiServerId: zz.clsiServerId().optional(),
  projectIdOrSubmissionId: zz.objectId().or(zz.submissionId()),
  optionalUserId: zz.objectId().optional(),
  buildId: zz.buildId(),
  filepath: zz.filepath(),
}

/**
 * @param {string} projectIdOrSubmissionId
 * @param {string|null} userId
 * @param {string} buildId
 * @param {string} compileBackendClass
 * @param {string} clsiServerId
 * @return {URL}
 */
export function getOutputZipURL(
  projectIdOrSubmissionId,
  userId,
  buildId,
  compileBackendClass,
  clsiServerId
) {
  compileBackendClass = schema.compileBackendClass.parse(compileBackendClass)
  clsiServerId = schema.optionalClsiServerId.parse(clsiServerId)
  const url = new URL(toAbsoluteUrl(Settings.apis.clsi.url))
  url.pathname = getFilePath(
    projectIdOrSubmissionId,
    userId,
    buildId,
    'output.zip'
  )
  url.searchParams.set('compileBackendClass', compileBackendClass)
  if (clsiServerId) url.searchParams.set('clsiserverid', clsiServerId)
  return url
}

/**
 * @param {string} projectIdOrSubmissionId
 * @param {string|null} userId
 * @param {string} buildId
 * @param {string} file
 * @param {string} clsiServerId
 * @return {URL}
 */
export function getOutputFileURL(
  projectIdOrSubmissionId,
  userId,
  buildId,
  file,
  clsiServerId
) {
  clsiServerId = schema.optionalClsiServerId.parse(clsiServerId)
  const url = new URL(toAbsoluteUrl(Settings.apis.clsi.downloadHost))
  url.pathname = getFilePath(projectIdOrSubmissionId, userId, buildId, file)
  if (clsiServerId) url.searchParams.set('clsiserverid', clsiServerId)
  return url
}

/**
 * @param {string} projectIdOrSubmissionId
 * @param {string|null} userId
 * @param {string} buildId
 * @param {string} file
 * @return {string}
 */
export function getFilePath(projectIdOrSubmissionId, userId, buildId, file) {
  projectIdOrSubmissionId = schema.projectIdOrSubmissionId.parse(
    projectIdOrSubmissionId.toString()
  )
  userId = schema.optionalUserId.parse(userId?.toString())
  buildId = schema.buildId.parse(buildId)
  file = schema.filepath.parse(file)
  let path = `/project/${projectIdOrSubmissionId}`
  if (userId) {
    path += `/user/${userId}`
  }
  path += `/build/${buildId}/output/${file}`
  return path
}
