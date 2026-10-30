/**
 * The target a release is built for: a base, a mount and a wiki name.
 *
 *     https://example.org/docs/  +  shelton/  +  photo-cli/
 *     http://localhost:8088/wikis/  +  shelton/  +  photo-cli/
 *     base (the deployment)           mount       name
 *
 * The base is the deployment's, subpath included; the mount groups a project's wikis; the
 * name is the wiki's own. A release is built for exactly one address, and hosting the wiki
 * somewhere else is a publish for that target, which is why nothing in the output has to
 * be location-independent.
 *
 * WHERE THE THREE COME FROM. Flags win over the declaration: `--base`, `--mount`, `--name`
 * over `site.baseUrl`, `site.mount`, and `site.self` for the name. A project that declares
 * `site.baseUrl` and no mount is the target it always was: the release is served at the base
 * itself. A mount makes the structured form, and a structured form needs a name.
 *
 * `site.baseUrl` has always been a host with no scheme, and `https` was assumed. It still
 * is, when none is written. A scheme is honoured when given, because a local target served
 * over plain http would otherwise write `https://localhost:8088/…` into every sitemap, feed
 * and `og:` tag.
 */

export const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/
/** A mount, a collection's path: one or more segments, `tools` or `clients/shelton`. */
export const MOUNT = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/

/**
 * The target, or `null` when no base is given anywhere, which is a build with nowhere
 * declared to be served from. `die` is how the caller refuses; it has to throw.
 */
export function resolveTarget({ base, mount, name } = {}, declaration = {}, die) {
  const rawBase = base ?? declaration.baseUrl
  const rawMount = mount ?? declaration.mount
  if (rawBase === undefined || rawBase === null || String(rawBase).trim() === "") {
    if (mount !== undefined || name !== undefined) {
      die("--mount and --name say where under a base a wiki goes, and there is no base: pass --base or declare site.baseUrl.")
    }
    return null
  }

  const parsed = parseBase(String(rawBase).trim(), die)

  let segments = []
  let resolvedName = null
  if (rawMount !== undefined && rawMount !== null && rawMount !== "") {
    resolvedName = name ?? declaration.self
    if (!resolvedName) die("a mount needs the wiki's name under it: pass --name or declare site.self.")
    if (!MOUNT.test(String(rawMount))) {
      die(`the mount "${rawMount}" is not a path: segments of lowercase letters, digits, "." "_" and "-", joined by "/".`)
    }
    if (!SEGMENT.test(String(resolvedName))) {
      die(`the name "${resolvedName}" is not a path segment: lowercase letters, digits, "." "_" and "-", starting with a letter or digit.`)
    }
    segments = [String(rawMount), String(resolvedName)]
  } else if (name !== undefined) {
    die("--name is the wiki's name under a mount, and there is no mount: pass --mount or declare site.mount.")
  }

  const path = parsed.basePath + segments.map((s) => `/${s}`).join("")
  return {
    scheme: parsed.scheme,
    host: parsed.host,
    base: `${parsed.scheme}://${parsed.host}${parsed.basePath}`,
    mount: segments.length ? segments[0] : null,
    name: segments.length ? segments[1] : null,
    url: `${parsed.scheme}://${parsed.host}${path}`,
    // What Quartz takes as `baseUrl`: the address with no scheme, since it writes `https://` itself.
    hostPath: `${parsed.host}${path}`,
    // The directory a build for a base given on the command line goes to.
    slug: `${parsed.host}${parsed.basePath}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  }
}

function parseBase(raw, die) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (withScheme && !/^https?:\/\//i.test(raw)) {
    die(`the base "${raw}" has a scheme other than http or https.`)
  }
  let url
  try {
    url = new URL(withScheme ? raw : `https://${raw}`)
  } catch {
    die(`the base "${raw}" is not a host with an optional path, such as example.org/docs or http://localhost:8088/wikis.`)
  }
  if (url.search || url.hash || url.username || url.password) {
    die(`the base "${raw}" carries a query, fragment or credentials; a base is a scheme, host and path.`)
  }
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.host,
    basePath: url.pathname.replace(/\/+$/, ""),
  }
}

/**
 * The record a release carries, at `static/awtRelease.json`, so the address it was built
 * for can be read back from the release itself.
 */
export function releaseRecord(target, { mode = "release", builtAt = new Date() } = {}) {
  return {
    version: 1,
    mode,
    url: target?.url ?? null,
    base: target?.base ?? null,
    mount: target?.mount ?? null,
    name: target?.name ?? null,
    builtAt: builtAt.toISOString(),
  }
}

/**
 * Compare a release's record to the target it should have been built for. A release with
 * no record predates targets, or was not published by `awt site publish`; that is a
 * different answer from a mismatch, so it is its own result.
 */
export function compareRecord(record, expected) {
  if (!record) return { ok: false, reason: "no-record" }
  if (!expected) return { ok: true, reason: "no-target", recorded: record.url }
  if (record.url === expected.url) return { ok: true, reason: "match", recorded: record.url }
  return { ok: false, reason: "mismatch", recorded: record.url, expected: expected.url }
}

/**
 * Rewrite the scheme of the target's address in a finished build. Quartz writes `https://`
 * in front of whatever `baseUrl` holds, in the sitemap, the feed and the `og:` tags; for a
 * target served over http that is wrong, and Quartz has no setting for it. Only the
 * target's own address is touched, never another host that happens to start the same way.
 */
export function retargetScheme(text, target) {
  if (!target || target.scheme !== "http") return text
  const escaped = target.hostPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // The address ends at a character that cannot continue a path segment, so `…/dios`
  // does not also rewrite `…/dios-data`.
  return text.replace(new RegExp(`https://${escaped}(?![A-Za-z0-9._~%-])`, "g"), `http://${target.hostPath}`)
}
