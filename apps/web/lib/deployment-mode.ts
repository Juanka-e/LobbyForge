export type DeploymentMode = 'official' | 'self_host';

/** Deployment mode is immutable runtime configuration, not a database toggle. */
export function getDeploymentMode(
  value: string | undefined = process.env.LOBBYFORGE_DEPLOYMENT_MODE
): DeploymentMode {
  return value === 'official' ? 'official' : 'self_host';
}

export function isOfficialDeployment(): boolean {
  return getDeploymentMode() === 'official';
}
