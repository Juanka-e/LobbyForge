// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MentionInput, type MentionUser } from '../MentionInput';

const MEMBERS: MentionUser[] = [
  { userId: 'u1', displayName: 'Alice' },
  { userId: 'u2', displayName: 'Bob' },
  { userId: 'u3', displayName: 'Charlie' },
];

// Wrap MentionInput so the controlled value tracks the latest onChange,
// otherwise typing into a value="" input is a no-op.
function MentionInputHarness({
  members,
  onMention,
  disabled,
}: {
  members?: MentionUser[];
  onMention?: (userId: string) => void;
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

function renderInput(overrides: { members?: MentionUser[]; disabled?: boolean } = {}) {
  const onMention = vi.fn();
  render(<MentionInputHarness onMention={onMention} {...overrides} />);
  return { onMention };
}

describe('MentionInput', () => {
  it('shows a filtered member dropdown after typing @ and a letter', async () => {
    const user = userEvent.setup();
    renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@a');
    // Alice matches 'a'; Bob and Charlie do not.
    expect(screen.getByRole('button', { name: /Alice/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Bob$/i })).not.toBeInTheDocument();
  });

  it('does not show the dropdown when there is no @', async () => {
    const user = userEvent.setup();
    renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'hello');
    expect(screen.queryByRole('button', { name: /Alice/i })).not.toBeInTheDocument();
  });

  it('inserts @displayName and calls onMention when a member is clicked', async () => {
    const user = userEvent.setup();
    const { onMention } = renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@al');
    await user.click(screen.getByRole('button', { name: /Alice/i }));
    expect(onMention).toHaveBeenCalledWith('u1');
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
    expect(onMention).toHaveBeenCalledWith('u2');
  });

  it('closes the dropdown on Escape without inserting a mention', async () => {
    const user = userEvent.setup();
    const { onMention } = renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@a');
    expect(screen.getByRole('button', { name: /Alice/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /Alice/i })).not.toBeInTheDocument();
    expect(onMention).not.toHaveBeenCalled();
  });

  it('is disabled when the disabled prop is set', () => {
    renderInput({ disabled: true });
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('filters case-insensitively', async () => {
    const user = userEvent.setup();
    renderInput();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '@BO');
    expect(screen.getByRole('button', { name: /Bob/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Alice/i })).not.toBeInTheDocument();
  });
});
