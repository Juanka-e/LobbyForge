export function isLobbyDemoAllowed(input: {
  official: boolean;
  nodeEnv: string | undefined;
  demoFlag: string | undefined;
}): boolean {
  if (input.official) return true;
  return input.nodeEnv !== 'production' && input.demoFlag === 'true';
}
