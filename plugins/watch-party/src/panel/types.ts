import type { MessageParams } from '@lobbyforge/plugin-sdk';

/** The panel's translator: `tFor` bound to the plugin and the viewer's language. */
export type Translate = (key: string, params?: MessageParams) => string;
