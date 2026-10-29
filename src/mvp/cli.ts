// FIRST, and for its side effect: enabling this workspace's Node compile cache
// before anything heavy is resolved. With every workspace asleep after its idle
// period, the gateway's wake pays the whole module-load phase again, and the
// compile cache is what keeps that phase off the critical path. It must come
// before ./server, which transitively pulls the o200k_base table (~300 ms of a
// ~930 ms module-load phase, measured on Node 22 against an empty workspace).
import { enableWorkspaceCompileCache } from './compileCache';
enableWorkspaceCompileCache();

import { loadMvpConfig } from './config';
import { startMvpService, MVP_MCP_PATH } from './server';
import { flushTelemetry } from './telemetry';
import { shutdownPosthogMcp } from './posthogMcp';
import { createLogger } from './log';

const log = createLogger('engine');
import { startSharingService } from '../sharing/loop';
import { defaultInForce, effectiveLevel } from '../sharing/state';

/**
 * CLI entry for the single-user ChatGPT MVP service.
 *
 * Required environment:
 *   MVP_MEMORY_DIR   dedicated owner memory directory (create a NEW folder)
 *   MVP_BASE_URL     externally reachable base URL (http://localhost:<port> for
 *                    local protocol tests; your public https URL for ChatGPT)
 *   MVP_OWNER_EMAIL  the single owner login email
 *   MVP_OWNER_PASSWORD  owner login secret (env-only, never in Git)
 * Optional:
 *   MVP_PORT (default 3471), MVP_HOST (default 127.0.0.1), MVP_LEDGER_REL, MVP_ACCESS_TOKEN_TTL_SECONDS
 */

async function main() {
  const config = loadMvpConfig();
  const mvp = await startMvpService(config);
  console.log(`[mvp] Renor single-owner memory service`);
  console.log(`[mvp] Memory directory : ${config.memoryDir}`);
  console.log(`[mvp] Ledger (source)  : ${config.ledgerRelPath}`);
  console.log(`[mvp] Derived index     : ${config.dbPath} (rebuildable from the ledger)`);
  console.log(`[mvp] Listening         : http://${config.host ?? '127.0.0.1'}:${config.port}`);
  console.log(`[mvp] MCP endpoint      : ${new URL(MVP_MCP_PATH, config.baseUrl).href}`);
  console.log(`[mvp] OAuth discovery   : ${new URL('/.well-known/oauth-authorization-server', config.baseUrl).href}`);
  console.log(`[mvp] Owner             : ${config.ownerEmail} (the only identity that can authorize)`);
  if (config.historyDir) {
    console.log(`[mvp] History directory : ${config.historyDir} (search_history: promoted ChatGPT history, manifest-verified)`);
  } else {
    console.log(`[mvp] History directory : not configured (search_history returns a bounded unconfigured result; set MVP_HISTORY_DIR to enable)`);
  }
  console.log(`[mvp] Local proof       : run the MCP client tests in tests/mvp/`);
  console.log(`[mvp] DCR allowlist     : ${config.allowedCallbackUris.length} exact callback URI(s)${config.allowedCallbackUris.length ? '' : ' — DENY BY DEFAULT: no client may register until MVP_ALLOWED_CALLBACK_URIS names exact callbacks'}`);
  console.log(`[mvp] Exposure boundary : ${(config.host ?? '127.0.0.1') === '127.0.0.1' ? 'loopback-bound' : `bound to ${config.host} (MVP_HOST)`}; any public use REQUIRES TLS termination in front.`);
  console.log(`[mvp] Embeddings         : ${config.embeddingProvider}${config.embeddingDims ? ` (${config.embeddingDims}-d)` : ''}`);
  log.info('learning_log', config.learning?.enabled
    ? { enabled: true, retention_days: config.learning.retentionDays, raw_queries: config.learning.rawQueries, db_path: config.learning.dbPath }
    : { enabled: false });
  // Sharing (src/sharing): anonymous usage numbers are on until the owner turns them off (or chooses), text for training only after their
  // yes. The first-run notice is printed BEFORE the sender starts, and recorded only once it was printed; the sender sends nothing under the
  // default until it is recorded (startSharingService).
  const sharingLoop = config.sharingDir === undefined ? null : startSharingService({
    dir: config.sharingDir, memoryDir: config.memoryDir, hosted: Boolean(config.gatewaySecret), log: console.log,
    print: line => { log.info('sharing_notice', { notice: line }); },
  });
  if (config.sharingDir !== undefined) {
    const byDefault = defaultInForce(config.sharingDir);
    console.log(`[mvp] Sharing           : ${effectiveLevel(config.sharingDir)} (${byDefault ? 'the default: nobody has chosen. Turn it off with `renor-engine telemetry off`' : "the owner's choice; off sends nothing"})`);
  }
  const shutdown = async () => {
    sharingLoop?.stop();
    try {
      await mvp.close();
    } finally {
      await Promise.allSettled([flushTelemetry(), shutdownPosthogMcp()]);
    }
    process.exit(0);
  };
  // Operator recovery from a lockout: a signal reaches only someone who can already control the process.
  process.on('SIGUSR2', () => { mvp.provider.operatorUnlock(); log.info('login_unlocked_by_signal', { detail: 'lockouts cleared by SIGUSR2; failure counts kept' }); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (mvp.idleExit) {
    console.log(`[mvp] On-demand         : exits after ${config.idleExitMs! / 1000}s with no work in flight (RENOR_ON_DEMAND); the gateway starts it again`);
    void mvp.idleExit.then(() => {
      console.log('[mvp] idle: no work in flight for the idle period; exiting cleanly');
      // Exit 0 is what leaves the unit stopped (Restart=on-failure). Nothing is in
      // flight, so a telemetry flush that hangs must not keep the engine resident.
      setTimeout(() => process.exit(0), 15_000).unref();
      return shutdown();
    });
  }
}

main().catch((err) => {
  log.error('startup_failed', {}, err);
  process.exit(1);
});
