/**
 * ContentDocumentLink sharing — how a file was shared with a record.
 *
 * The link carries two fields worth preserving: ShareType (Viewer /
 * Collaborator / Inferred) and Visibility (who can see it). Copying every
 * link as a plain Viewer link, which is what the tool used to do, silently
 * downgrades Collaborator access in the target org.
 */

// What we fall back to when the target org rejects the source's combination.
const SAFE_SHARING = { ShareType: 'V', Visibility: 'InternalUsers' };

/**
 * Builds the ShareType/Visibility half of a ContentDocumentLink insert from
 * the link as it was recorded in the manifest.
 *
 * ShareType 'I' (Inferred) is assigned by Salesforce for a document's original
 * publish location and cannot be re-created explicitly, so it becomes 'V' —
 * the closest thing an insert can express. Manifests written before this
 * existed carry no shareType and get the old default.
 */
function linkSharing(link = {}) {
  const shareType = link.shareType && link.shareType !== 'I' ? link.shareType : 'V';
  const out = { ShareType: shareType };
  if (link.visibility) out.Visibility = link.visibility;
  return out;
}

module.exports = { linkSharing, SAFE_SHARING };
