import { Fragment, type ReactNode } from 'react';

/**
 * Put elements — a link, a `<code>`, a `<strong>` — where a translated
 * sentence says `{name}`:
 *
 *   rich(t('auth.login.poweredBy'), { brand: <a href="…">LobbyForge</a> })
 *
 * The whole sentence stays one catalogue string, so each language decides
 * where the element sits; gluing translated fragments around it would fix
 * the English word order for everyone.
 *
 * Call `t` WITHOUT these arguments, so their `{name}` markers survive
 * formatting. Plain-text arguments go through `t` as usual:
 *
 *   rich(t('x.revokeBody', { count }), { code: <code>{invite}</code> })
 *
 * Works in server and client components alike — it is not a hook.
 */
export function rich(message: string, elements: Record<string, ReactNode>): ReactNode {
  return message.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={index}>{name !== undefined && name in elements ? elements[name] : part}</Fragment>;
  });
}
