'use strict'

/**
 * Windows test helpers for symlink-dependent cases.
 *
 * Windows without Developer Mode (or inside some sandboxes) denies symlink
 * creation with EPERM/EACCES. A test that needs a symlink cannot exercise its
 * security property on such a machine, so it must skip rather than fail.
 *
 * This mirrors the precedent in `tests/hooks/config-protection.test.js`.
 */

function isSymlinkPrivilegeError(error) {
  return Boolean(error) && (error.code === 'EPERM' || error.code === 'EACCES')
}

/**
 * Attempt to create a symlink.
 *
 * @returns {boolean} `true` when the link was created, `false` when the platform
 *   denied the symlink privilege (callers should skip the case).
 * @throws rethrows any error that is not a symlink privilege denial.
 */
function trySymlinkSync(fs, target, link, type) {
  try {
    fs.symlinkSync(target, link, type)
    return true
  } catch (error) {
    if (isSymlinkPrivilegeError(error)) return false
    throw error
  }
}

module.exports = { isSymlinkPrivilegeError, trySymlinkSync }
