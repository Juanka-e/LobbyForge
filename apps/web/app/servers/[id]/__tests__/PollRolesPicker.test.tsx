// @vitest-environment happy-dom
/**
 * Who may create polls, chosen on the Poll app's card: each box is the
 * role's `create_polls` permission, saved through the role API (whose
 * checks — Manage Roles, hierarchy, no granting what you lack — stand).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { PollRolesPicker, type PollRole } from '../PollRolesPicker';

const SERVER = '00000000-0000-4000-8000-0000000000aa';

const ROLES: PollRole[] = [
  { id: 'r-everyone', name: '@everyone', position: 0, permissions: ['send_messages'] },
  { id: 'r-mod', name: 'Moderator', position: 5, permissions: ['manage_messages', 'create_polls'] },
  { id: 'r-admin', name: 'Admin', position: 9, permissions: ['administrator'] },
];

let patchStatus = 200;
const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
  new Response(JSON.stringify(patchStatus === 200 ? { role: {} } : { error: 'Forbidden' }), { status: patchStatus })
);

function renderPicker(props: Partial<Parameters<typeof PollRolesPicker>[0]> = {}, locale = 'en') {
  const onChanged = vi.fn(async () => {});
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      <PollRolesPicker serverId={SERVER} roles={ROLES} canManageRoles onChanged={onChanged} {...props} />
    </I18nProvider>
  );
  return { onChanged, group: screen.getByRole('group', { name: /create polls/i }) };
}

beforeEach(() => {
  patchStatus = 200;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PollRolesPicker', () => {
  it('lists roles highest first; Administrator roles are always ticked and locked', () => {
    const { group } = renderPicker();
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual(['Admin(Administrator)', 'Moderator', '@everyone']);
    const [admin, mod, everyone] = boxes as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    expect(admin.checked && admin.disabled).toBe(true);
    expect(mod.checked && !mod.disabled).toBe(true);
    expect(everyone.checked || everyone.disabled).toBe(false);
  });

  it('grants and revokes create_polls through the role API, keeping the other permissions', async () => {
    const { group, onChanged } = renderPicker();
    fireEvent.click(within(group).getByRole('checkbox', { name: '@everyone' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/servers/${SERVER}/roles/r-everyone`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ permissions: ['send_messages', 'create_polls'] }) })
    );

    fireEvent.click(within(group).getByRole('checkbox', { name: 'Moderator' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/servers/${SERVER}/roles/r-mod`,
      expect.objectContaining({ body: JSON.stringify({ permissions: ['manage_messages'] }) })
    );
  });

  it('says why when the role API refuses, and leaves the roles as they were', async () => {
    patchStatus = 403;
    const { group, onChanged } = renderPicker();
    fireEvent.click(within(group).getByRole('checkbox', { name: '@everyone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("You can't change @everyone");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('is read-only without Manage Roles, and says so', () => {
    const { group } = renderPicker({ canManageRoles: false });
    expect(within(group).getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled)).toBe(true);
    expect(within(group).getByText('Changing this needs Manage Roles.')).toBeInTheDocument();
  });

  it('speaks Turkish', () => {
    render(
      <I18nProvider {...providerPropsFor('tr')}>
        <PollRolesPicker serverId={SERVER} roles={ROLES} canManageRoles onChanged={async () => {}} />
      </I18nProvider>
    );
    expect(screen.getByRole('group', { name: 'Metin kanallarında kimler anket açabilir' })).toBeInTheDocument();
    expect(screen.getByText('(Yönetici)')).toBeInTheDocument();
  });
});
