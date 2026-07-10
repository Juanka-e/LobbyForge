export class LobbyForgeError extends Error {
  public code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'LobbyForgeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
