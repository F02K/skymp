import type { ModuleRequest, ModuleResponse, ModuleRouter } from './types.js';

interface Route {
  method: string;
  path: string;
  handler: (request: ModuleRequest) => Promise<ModuleResponse> | ModuleResponse;
}

export class NamespacedRouter implements ModuleRouter {
  private readonly routes: Route[] = [];
  constructor(private readonly namespace: string) {}
  add(method: string, path: string, handler: Route['handler']): void {
    if (!path.startsWith('/')) throw new Error('Module route paths must begin with /');
    this.routes.push({ method: method.toUpperCase(), path: `${this.namespace}${path}`, handler });
  }
  async dispatch(request: ModuleRequest): Promise<ModuleResponse | null> {
    const route = this.routes.find((candidate) => candidate.method === request.method && candidate.path === request.path);
    return route ? route.handler(request) : null;
  }
}

export class RouterRegistry {
  private readonly routers: NamespacedRouter[] = [];
  create(moduleId: string): NamespacedRouter {
    const router = new NamespacedRouter(`/api/v2/modules/${moduleId}`);
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
}
