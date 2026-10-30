/**
 * `awt site host`: run a library's server on this machine, with a stock nginx.
 *
 * `awt site deploy` lays a library out as a tree and writes the nginx config beside it, in the
 * library's `deploy.to`; what is left to serve it is a container that mounts the two, the same
 * contract a server elsewhere follows:
 *
 *     <to>/library/   ->  /srv/library/        the tree
 *     <to>/conf.d/    ->  /etc/nginx/conf.d/   the config
 *
 * Nothing of ours stays resident; the server is nginx, and what keeps the tree current is publish,
 * which copies a release into it after each swap.
 *
 * DOCKER MOUNTS DIRECTORIES, AND ONLY WHAT IT SHARES. A single file mounted as a config failed outright
 * and a directory in an unshared path arrived empty, so the two are directories and `probe` checks what
 * the container can actually see.
 */
import { spawnSync } from "node:child_process"
import path from "node:path"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/** `awt-host-<library>`: the container is named for the library it serves, and labelled so it is known as ours. */
export const containerName = (targetName) => `awt-host-${targetName}`
export const LABEL = "awt.host"

/**
 * The container for one library, as data. The deploy plan says what is in the tree; this says how it
 * is served.
 *
 *   machine      from `loadMachine`
 *   targetName   which library
 *   deploy       its deploy plan, from `planDeploy`
 *   port         the port on this machine; the library's own port when not given
 */
export function planHost({ machine, targetName, deploy, port }) {
  const target = machine.targets.get(targetName)
  if (!target) {
    throw new Error(`no library "${targetName}"${machine.targets.size ? `; libraries are ${[...machine.targets.keys()].join(", ")}` : ""}.`)
  }
  if (!target.deploy || target.deploy.remote) {
    throw new Error(`the library "${targetName}" does not deploy to a directory on this machine, so there is no tree here to serve.`)
  }
  const url = new URL(target.base)
  const basePath = url.pathname.replace(/\/+$/, "")
  const hostPort = Number(port ?? (url.port || (url.protocol === "https:" ? 443 : 80)))
  const local = LOCAL_HOSTS.has(url.hostname)
  const root = target.deploy.path

  const wikis = deploy.wikis.map((w) => ({ ...w, path: `${basePath}/${w.path}/` }))
  const name = containerName(targetName)
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=${targetName}`,
    "--restart",
    "unless-stopped",
    "-p",
    `127.0.0.1:${hostPort}:80`,
    "-v",
    `${path.join(root, "conf.d")}:/etc/nginx/conf.d:ro`,
    "-v",
    `${path.join(root, "library")}:/srv/library:ro`,
    "nginx:alpine",
  ]

  return { target: targetName, base: target.base, local, port: hostPort, dir: root, wikis, docker: { name, args } }
}

// ---------------------------------------------------------------------- doing it

const docker = (args, run) => run("docker", args, { encoding: "utf8" })

/** The container for a target, if it exists and is ours: `{running}`, or null. A same-named stranger is an error. */
function ours(name, targetName, run) {
  const found = docker(["inspect", "--format", `{{.State.Running}} {{index .Config.Labels "${LABEL}"}}`, name], run)
  if (found.status !== 0) return null
  const [running, label] = String(found.stdout).trim().split(" ")
  if (label !== targetName) throw new Error(`a container named ${name} exists and was not started by awt site host; remove or rename it.`)
  return { running: running === "true" }
}

/** Replace the target's container with one running this plan. Only a container that is ours is replaced. */
export function up(plan, { run = spawnSync } = {}) {
  const probe = docker(["version", "--format", "{{.Server.Version}}"], run)
  if (probe.status !== 0) throw new Error("docker is not running or not installed: `docker version` failed.")
  if (ours(plan.docker.name, plan.target, run)) docker(["rm", "-f", plan.docker.name], run)
  const started = docker(plan.docker.args, run)
  if (started.status !== 0) throw new Error(`docker run failed: ${String(started.stderr).trim().split("\n").pop()}`)
  return { name: plan.docker.name, id: String(started.stdout).trim().slice(0, 12) }
}

/** Remove the target's container. Nothing to remove is not an error; a container that is not ours is. */
export function down(targetName, { run = spawnSync } = {}) {
  const name = containerName(targetName)
  if (!ours(name, targetName, run)) return { name, removed: false }
  docker(["rm", "-f", name], run)
  return { name, removed: true }
}

/**
 * Ask the running server what it serves: the landing page and each wiki, retried for a few seconds
 * while nginx starts. A wiki copied into the tree that answers 404 is one the container cannot see,
 * and Docker not sharing the tree is the usual reason, so that is what the answer says.
 */
export async function probe(plan, { get = fetchStatus, wait = 5000, now = Date.now, sleep = delay } = {}) {
  const origin = `http://127.0.0.1:${plan.port}`
  const basePath = new URL(plan.base).pathname.replace(/\/+$/, "")
  const deadline = now() + wait
  let landing = await get(`${origin}${basePath}/`)
  while (landing === 0 && now() < deadline) {
    await sleep(250)
    landing = await get(`${origin}${basePath}/`)
  }
  const wikis = []
  for (const w of plan.wikis) {
    const status = await get(`${origin}${w.path}`)
    wikis.push({
      key: w.key,
      status,
      serving: status === 200,
      note:
        status === 200
          ? "serving"
          : status === 404 && w.state === "ready"
            ? `its release was copied into the tree and the container does not see it; Docker may not share ${plan.dir}`
            : status === 404
              ? "not deployed yet"
              : `answered ${status || "nothing"}`,
    })
  }
  return { landing, wikis }
}

async function fetchStatus(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status
  } catch {
    return 0
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
