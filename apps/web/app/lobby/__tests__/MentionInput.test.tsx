// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MentionInput, type MentionUser } from '../MentionInput';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';

const MEMBERS: MentionUser[] = [
  { userId: 'u1', displayName: 'Alice' },
  { userId: 'u2', displayName: 'Bob', username: 'bobby_b' },
  { userId: 'u3', displayName: 'Charlie' },
  { userId: 'u4', displayName: 'İrem Işık' },
];

// Wrap MentionInput so the controlled value tracks the latest onChange,
// otherwise typing into a value="" input is a no-op.
function MentionInputHarness({
  members,
  onMention,
  disabled,
}: {
  members?: MentionUser[];
  onMention?: (userId: string, label: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <MentionInput
      value={value}
      onChange={setValue}
      members={members ?? MEMBERS}
      onMention={onMention}
      disabled={disabled}
    />
  );
}

function renderInput(
  overrides: { members?: MentionUser[]; disabled?: boolean } = {},
  locale = 'en'
) {
  const onMention = vi.fn();
  render(
    <I18nProvider {...providerPropsFor(locale)}>
      <MentionInputHarness onMention={onMention} {...overrides} />
    </I18nProvider>
  );
  return { onMention };
}

describe('MentionInput', () => {
  it('shows a filtered member dropdown after typing @ and a letter', async () => {
    const user = userEvent.setup();
    renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@a');
    // Alice matches 'a'; Bob and Charlie do not.
    expect(screen.getByRole('option', { name: /Alice/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Bob$/i })).not.toBeInTheDocument();
  });

  it('does not show the dropdown when there is no @', async () => {
    const user = userEvent.setup();
    renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'hello');
    expect(screen.queryByRole('option', { name: /Alice/i })).not.toBeInTheDocument();
  });

  it('inserts @displayName and calls onMention when a member is clicked', async () => {
    const user = userEvent.setup();
    const { onMention } = renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@al');
    await user.click(screen.getByRole('option', { name: /Alice/i }));
    expect(onMention).toHaveBeenCalledWith('u1', 'Alice');
    // The input value now contains the @DisplayName insertion.
    expect(input.value).toContain('@Alice');
  });

  it('navigates the dropdown with ArrowDown / ArrowUp and selects with Enter', async () => {
    const user = userEvent.setup();
    const { onMention } = renderInput({
      members: [
        { userId: 'u1', displayName: 'Aaron' },
        { userId: 'u2', displayName: 'Ava' },
        { userId: 'u3', displayName: 'Axel' },
      ],
    });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@a');
    // First item (Aaron) is highlighted by default.
    await user.keyboard('{ArrowDown}'); // -> Ava
    await user.keyboard('{Enter}');
    expect(onMention).toHaveBeenCalledWith('u2', 'Ava');
  });

  it('closes the dropdown on Escape without inserting a mention', async () => {
    const user = userEvent.setup();
    const { onMention } = renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@a');
    expect(screen.getByRole('option', { name: /Alice/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option', { name: /Alice/i })).not.toBeInTheDocument();
    expect(onMention).not.toHaveBeenCalled();
  });

  it('is disabled when the disabled prop is set', () => {
    renderInput({ disabled: true });
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('labels the dropdown in the active language', async () => {
    const user = userEvent.setup();
    renderInput({}, 'tr');
    await user.type(screen.getByRole('textbox'), '@a');
    expect(screen.getByText('@a ile eşleşen üyeler')).toBeInTheDocument();
  });

  it('filters case-insensitively', async () => {
    const user = userEvent.setup();
    renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@BO');
    expect(screen.getByRole('option', { name: /Bob/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Alice/i })).not.toBeInTheDocument();
  });

  it('matches a handle and shows it under the name', async () => {
    const user = userEvent.setup();
    renderInput();
    await user.type(screen.getByRole('textbox'), '@bobby');
    const option = screen.getByRole('option', { name: /Bob/ });
    expect(option).toHaveTextContent('@bobby_b');
  });

  it('matches Turkish names the way a Turkish reader types them (İ/I)', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider {...providerPropsFor('tr')}>
        <MentionInputHarness />
      </I18nProvider>
    );
    const input = screen.getByRole('textbox');
    await user.type(input, '@ir');
    expect(screen.getByRole('option', { name: /İrem Işık/ })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '@ış');
    expect(screen.getByRole('option', { name: /İrem Işık/ })).toBeInTheDocument();
  });

  it('the suggestions are a labelled list of options; the arrow keys move the selected one', async () => {
    const user = userEvent.setup();
    renderInput({ members: [{ userId: 'a1', displayName: 'Ada' }, { userId: 'a2', displayName: 'Alp' }] });
    await user.type(screen.getByRole('textbox'), '@a');
    const list = screen.getByRole('listbox', { name: 'Members matching @a' });
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{ArrowDown}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('the caret lands after the picked name at once, so what is typed next follows it', async () => {
    const user = userEvent.setup();
    renderInput({ members: [{ userId: 'a1', displayName: 'Ada' }] });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'hi @a there');
    await user.type(input, 'd', { skipClick: true, initialSelectionStart: 5, initialSelectionEnd: 5 });
    // The pick, and no frame waited for: a key pressed right now must land
    // after "@Ada " — a caret placed on the next frame was too late.
    act(() => {
      fireEvent.mouseDown(screen.getByRole('option', { name: /Ada/ }));
    });
    expect(input.value).toBe('hi @Ada  there');
    expect(input.selectionStart).toBe('hi @Ada '.length);
    expect(input.selectionEnd).toBe('hi @Ada '.length);
  });
});
