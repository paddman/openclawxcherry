export type InfrastructureProviderKind = "proxmox" | "vmware" | "linux" | "windows";

export type InfrastructureResourceKind =
  | "cluster"
  | "node"
  | "host"
  | "virtual-machine"
  | "container"
  | "storage"
  | "service";

export type InfrastructureResource = {
  providerId: string;
  providerKind: InfrastructureProviderKind;
  id: string;
  kind: InfrastructureResourceKind;
  name: string;
  status?: string;
  parent?: string;
  cpuPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  diskPercent?: number;
  uptimeSeconds?: number;
  address?: string;
  metadata?: Record<string, unknown>;
  observedAt: string;
};

export type InfrastructurePatchSummary = {
  providerId: string;
  providerKind: InfrastructureProviderKind;
  targetId: string;
  targetName: string;
  availableUpdates: number;
  securityUpdates?: number;
  rebootRequired?: boolean;
  packageManager?: string;
  details?: unknown;
  observedAt: string;
};

export type InfrastructureOperation = {
  providerId: string;
  targetId: string;
  action: string;
  parameters?: Record<string, unknown>;
};

export type InfrastructureOperationResult = {
  operation: InfrastructureOperation;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type InfrastructureProvider = {
  id: string;
  kind: InfrastructureProviderKind;
  actions: string[];
  queries: string[];
  inventory: (query?: string) => Promise<InfrastructureResource[]>;
  query?: (
    targetId: string,
    query: string,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>;
  monitor?: () => Promise<InfrastructureResource[]>;
  patchScan?: (targetId?: string) => Promise<InfrastructurePatchSummary[]>;
  execute: (operation: InfrastructureOperation) => Promise<unknown>;
  rollbackFor?: (
    operation: InfrastructureOperation,
    result?: unknown,
  ) => Promise<InfrastructureOperation | undefined> | InfrastructureOperation | undefined;
};

type RegistryState = {
  providers: Map<string, InfrastructureProvider>;
};

type RegistryGlobal = typeof globalThis & {
  __openclawInfrastructureRegistryV1?: RegistryState;
};

function registryState(): RegistryState {
  const root = globalThis as RegistryGlobal;
  root.__openclawInfrastructureRegistryV1 ??= {
    providers: new Map<string, InfrastructureProvider>(),
  };
  return root.__openclawInfrastructureRegistryV1;
}

export function registerInfrastructureProvider(
  provider: InfrastructureProvider,
): () => void {
  const state = registryState();
  if (state.providers.has(provider.id)) {
    throw new Error(`Infrastructure provider is already registered: ${provider.id}`);
  }
  state.providers.set(provider.id, provider);
  return () => {
    if (state.providers.get(provider.id) === provider) {
      state.providers.delete(provider.id);
    }
  };
}

export function listInfrastructureProviders(): InfrastructureProvider[] {
  return [...registryState().providers.values()].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function getInfrastructureProvider(providerId: string): InfrastructureProvider {
  const provider = registryState().providers.get(providerId);
  if (!provider) {
    throw new Error(`Unknown infrastructure provider: ${providerId}`);
  }
  return provider;
}
