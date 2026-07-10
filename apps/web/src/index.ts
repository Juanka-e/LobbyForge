export const APP_NAME = 'LobbyForge Web';
export const APP_VERSION = '0.1.0';

export interface RouteInfo {
  path: string;
  title: string;
  requiresAuth: boolean;
}

export const ROUTES = {
  home: { path: '/', title: 'Home', requiresAuth: false },
  login: { path: '/login', title: 'Login', requiresAuth: false },
  dashboard: { path: '/dashboard', title: 'Dashboard', requiresAuth: true },
  room: { path: '/room/:id', title: 'Voice Room', requiresAuth: true },
  settings: { path: '/settings', title: 'Settings', requiresAuth: true },
} as const satisfies Record<string, RouteInfo>;

export function findRouteByPath(path: string): RouteInfo | undefined {
  return Object.values(ROUTES).find((r) => r.path === path);
}
