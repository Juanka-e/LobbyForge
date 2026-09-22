// @vitest-environment happy-dom
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PluginSurface } from '../PluginSurface';

/**
 * beta-review regression guards for the two defects PluginSurface exists
 * to prevent. See the component's own doc comment for the history.
 */
describe('PluginSurface', () => {
  it('renders the plugin surface when the plugin ships one', () => {
    render(
      <PluginSurface
        render={() => <p>plugin panel</p>}
        props={{}}
        fallback={<p>generic surface</p>}
      />
    );
    expect(screen.getByText('plugin panel')).toBeTruthy();
    expect(screen.queryByText('generic surface')).toBeNull();
  });

  it('falls back when the plugin ships no client UI (renderClient → null)', () => {
    // Poll and Dice Bot do exactly this. Before the fallback moved into
    // this component, the caller only saw a truthy element and those
    // plugins rendered an empty panel with no way to act on the game.
    render(<PluginSurface render={() => null} props={{}} fallback={<p>generic surface</p>} />);
    expect(screen.getByText('generic surface')).toBeTruthy();
  });

  it('treats undefined the same as null', () => {
    render(
      <PluginSurface render={() => undefined} props={{}} fallback={<p>generic surface</p>} />
    );
    expect(screen.getByText('generic surface')).toBeTruthy();
  });

  it('passes the props object straight through to the plugin', () => {
    const seen: unknown[] = [];
    render(
      <PluginSurface
        render={(props) => {
          seen.push(props);
          return <p>ok</p>;
        }}
        props={{ actorUserId: 'user-1', players: [] }}
        fallback={null}
      />
    );
    expect(seen[0]).toEqual({ actorUserId: 'user-1', players: [] });
  });

  it('gives a hook-using plugin its own hook list', () => {
    // The panel's hooks must belong to PluginSurface, not to whatever
    // rendered it — otherwise a conditional mount changes the caller's
    // hook count between renders and React throws #310.
    const HookyPlugin = () => {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          count {count}
        </button>
      );
    };

    function Host({ mounted }: { mounted: boolean }) {
      // A hook in the HOST, declared before the conditional child: if the
      // plugin's hooks leaked up here, mounting the child would shift the
      // host's hook list and the re-render below would throw.
      const [label] = useState('host');
      return (
        <div>
          <span>{label}</span>
          {mounted ? (
            <PluginSurface render={() => <HookyPlugin />} props={{}} fallback={null} />
          ) : null}
        </div>
      );
    }

    const { rerender } = render(<Host mounted={false} />);
    rerender(<Host mounted />);
    fireEvent.click(screen.getByText('count 0'));
    expect(screen.getByText('count 1')).toBeTruthy();
    rerender(<Host mounted={false} />);
    expect(screen.queryByText(/^count /)).toBeNull();
  });
});
