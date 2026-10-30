/**
 * Building and releasing a wiki as a Quartz site.
 *
 * Its own package rather than a layer: the stack below is a resolution stack, and
 * a build orchestrator resolves nothing. It clones a
 * pinned renderer, stages a build, renames a release, and turns mermaid sources
 * into pictures. It may read the index from `core`; nothing below it may depend on
 * it.
 *
 * It also owns the one zero-dependency Quartz plugin in `quartz-plugins/awt`, which
 * stays dependency-free by consuming the materialised index as data, and the
 * derivation of the config Quartz reads (`lib/site-config.js`).
 */
export {bootstrap, gitignoreGaps} from './lib/bootstrap.js'
export {extractDeclaration, renderDeclaration} from './lib/migrate.js'
export {deriveSiteConfig, writeSiteConfig, DERIVED_CONFIG, PROJECT_CONFIG, PLUGIN_SOURCE} from './lib/site-config.js'
export {publish, verifyRelease, planRelease, RELEASE_RECORD} from './lib/release.js'
export {resolveTarget, releaseRecord, compareRecord, retargetScheme} from './lib/target.js'
export {
  configDir,
  loadMachine,
  loadMachineIfPresent,
  registerWiki,
  unregisterWiki,
  describeMachine,
  pluginRegistry,
  addressOf,
  releaseFor,
  migrateMachine,
  readDefaultTarget,
} from './lib/machine.js'
export {planDeploy, runDeploy, deployAfterPublish, nginxConf, indexPage, accessFor} from './lib/deploy.js'
export {serve, DEFAULT_PORT, wsPortFor} from './lib/serve.js'
export {proxy, createProxy, readProxyConfig, defaultConfigFile, DEFAULT_PROXY_PORT} from './lib/proxy.js'
export {serviceFor, serviceName, installService, uninstallService} from './lib/proxy-service.js'
export {followNotes, FOLLOWING} from './lib/follow.js'
export {renderDiagrams, rasterize, disposeRenderer} from './lib/diagrams.js'
export {prerenderDiagrams} from './lib/diagrams-pass.js'
export {findFont, loadFont} from './lib/font-metrics.js'
export {planHost, up, down, probe, containerName, LABEL} from './lib/host.js'
export {atlasProject} from './lib/atlas.js'
export {BUILD, INDEX, DERIVED, OFFLINE, DEV, PUBLISHED, HANDOFF, LEGACY, ensureBuildDir, ensureSiteDir, publishedDir, legacyPresent, removeLegacy, cleanBuild} from './lib/layout.js'
