import fs from 'node:fs';
import { ownerAccount } from './store.mjs';
import { environmentComputerPolicy } from './environment-computer.mjs';
import { createDesktopBrokerClient } from './desktop-broker-server.mjs';
import { DesktopProviderRuntime } from './desktop-provider-runtime.mjs';
import { desktopEngineExecution } from './desktop-engine-adapter.mjs';
// This separate manifest is opt-in. Invalid/present activation never falls back
// to a host desktop or the previous VM. No import provisions or starts a VM.
export function loadDesktopProvider({
  file = '/etc/stellarcortex/desktop-provider.json',
  dataDir,
  isolation,
  trustedUid = 0,
  brokerFactory = createDesktopBrokerClient,
} = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== trustedUid || stat.mode & 0o022)
    throw Error('Desktop activation must be trusted-owned and not agent-writable');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.enabled === false) return null;
  if (
    config.enabled !== true ||
    config.provider !== 'qemu-kvm-ubuntu-desktop' ||
    config.brokerSocket !== '/run/stellarcortex-desktop-broker/broker.sock' ||
    !Array.isArray(config.records)
  )
    throw Error('Invalid desktop activation; refusing fallback');
  // Without the isolation policy no virtual computer is offered. A bot set to one gets a refusal, never the host.
  if (!isolation?.enabled) {
    console.error(
      'Virtual computers are off: /etc/stellarcortex/desktop-isolation.json is missing.',
    );
    return null;
  }
  const accountId = ownerAccount(dataDir);
  if (config.records.some(r => r.accountId !== accountId))
    throw Error('Desktop registration belongs to another application account');
  const loadRecords = () => {
    const currentStat = fs.lstatSync(file);
    if (
      !currentStat.isFile() ||
      currentStat.isSymbolicLink() ||
      currentStat.uid !== trustedUid ||
      currentStat.mode & 0o022
    )
      throw Error('Trusted computer registry required');
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.records.some(r => r.accountId !== accountId))
      throw Error('Computer belongs to another account');
    if (!current.environmentComputer) provider.environmentPolicy = null;
    else if (provider.environmentPolicy?.computerId !== current.environmentComputer.computerId)
      provider.environmentPolicy = environmentComputerPolicy(current.environmentComputer);
    return current.records;
  };
  const provider = new DesktopProviderRuntime({
    loadRecords,
    environmentPolicy: config.environmentComputer || null,
    records: config.records,
    broker: brokerFactory(config.brokerSocket),
    enabled: true,
    approved: config.lifecycleApproved === true,
  });
  provider.accountId = accountId;
  return {
    desktopProvider: provider,
    guestExecution: desktopEngineExecution(provider, { accountId, isolation }),
  };
}
