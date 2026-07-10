export interface User {
  id: string;
  email: string | null;
  passwordHash: string | null;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  isGuest: boolean;
  statusText: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Server {
  id: string;
  name: string;
  slug: string | null;
  ownerUserId: string;
  iconUrl: string | null;
  defaultLocale: string;
  isPublic: boolean;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: 'text' | 'voice' | 'activity' | 'announcement' | 'stage';
  position: number;
  pluginId: string | null;
  topic: string | null;
  createdAt: Date;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: Record<string, boolean>;
  createdAt: Date;
}

export interface Membership {
  id: string;
  serverId: string;
  userId: string;
  roleId: string | null;
  nickname: string | null;
  createdAt: Date;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface GameSession {
  id: string;
  serverId: string;
  channelId: string;
  pluginId: string;
  status: 'lobby' | 'running' | 'paused' | 'ended' | 'cancelled';
  state: Record<string, unknown>;
  publicSummary: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface GameSessionPlayer {
  id: string;
  sessionId: string;
  userId: string;
  characterName: string | null;
  characterData: Record<string, unknown>;
  status: string;
  score: number;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface Invite {
  id: string;
  serverId: string;
  createdBy: string | null;
  code: string;
  maxUses: number | null;
  currentUses: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface UserSession {
  id: string;
  userId: string;
  tokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  lastActive: Date;
  expiresAt: Date;
  createdAt: Date;
}
