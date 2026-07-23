import type { ModuleRequest, ModuleResponse, ModuleRouter } from './types.js';

interface Route {
  method: string;
  path: string;
  localPath: string;
  handler: (request: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse;
}

export class NamespacedRouter implements ModuleRouter {
  private readonly routes: Route[] = [];
  constructor(private readonly namespace: string) {}
  add(method: string, path: string, handler: Route['handler']): void {
    if (!path.startsWith('/')) throw new Error('Module route paths must begin with /');
    this.routes.push({ method: method.toUpperCase(), path: `${this.namespace}${path}`, localPath: path, handler });
  }
  async dispatch(request: ModuleRequest): Promise<ModuleResponse | null> {
    const route = this.routes.find((candidate) => candidate.method === request.method && candidate.path === request.path);
    return route ? route.handler(request) : null;
  }
  has(method: string, localPath: string): boolean {
    return this.routes.some((candidate) => candidate.method === method.toUpperCase() && candidate.localPath === localPath);
  }
  async dispatchLocal(localPath: string, request: ModuleRequest): Promise<ModuleResponse | null> {
    const route = this.routes.find((candidate) => candidate.method === request.method && candidate.localPath === localPath);
    return route ? route.handler(request) : null;
  }
}

export class RouterRegistry {
  private readonly routers: NamespacedRouter[] = [];
  create(moduleId: string): NamespacedRouter {
    const router = new NamespacedRouter(`/api/modules/${moduleId}`);
    this.routers.push(router);
    return router;
  }
  async dispatch(request: ModuleRequest): Promise<ModuleResponse | null> {
    for (const router of this.routers) {
      const response = await router.dispatch(request);
      if (response) return response;
    }
    return null;
  }
  hasLauncherCapability(capability: string): boolean {
    const requiredPaths = launcherCapabilityPaths(capability);
    return requiredPaths.length > 0
      && requiredPaths.every((path) =>
        this.routers.some((router) => router.has('GET', path))
      );
  }
  async dispatchLauncher(path: string, request: ModuleRequest): Promise<ModuleResponse | null> {
    for (const router of this.routers) {
      const response = await router.dispatchLocal(path, request);
      if (response) return response;
    }
    return null;
  }
}

function launcherCapabilityPaths(capability: string): string[] {
  if (['news', 'mods', 'metrics'].includes(capability))
    return [`/launcher/${capability}`];
  if (capability === 'clientDistribution')
    return ['/launcher/client/manifest', '/launcher/client/download'];
  if (capability === 'modpack')
    return ['/launcher/modpack/manifest', '/launcher/modpack/download'];
  return [];
}
