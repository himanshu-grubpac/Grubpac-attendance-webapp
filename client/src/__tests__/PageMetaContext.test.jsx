import { describe, it, expect } from 'vitest';
import React, { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { PageMetaProvider, usePageMetaContext } from '../context/PageMetaContext.jsx';

function HelpListPage() {
  const { setMeta } = usePageMetaContext();

  useEffect(() => {
    setMeta({
      actions: <button type="button">New ticket</button>,
    });
    return () => setMeta(null);
  }, [setMeta]);

  return <div>Help list</div>;
}

function HelpDetailPage() {
  const { setMeta } = usePageMetaContext();

  useEffect(() => {
    setMeta({
      actions: <button type="button">Back</button>,
    });
    return () => setMeta(null);
  }, [setMeta]);

  return <div>Help detail</div>;
}

function PageToolbarProbe() {
  const { meta } = usePageMetaContext();
  const actionLabels = React.Children.toArray(meta.actions?.props?.children ?? meta.actions)
    .flatMap((node) => {
      if (typeof node === 'string') return [node];
      if (React.isValidElement(node)) return [node.props.children];
      return [];
    })
    .filter(Boolean);

  return (
    <div
      data-testid="toolbar-actions"
      data-count={actionLabels.length}
      data-labels={actionLabels.join(',')}
    />
  );
}

function NavToDetail() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/employee/help/ticket-1')}>
      Open ticket
    </button>
  );
}

function NavToList() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/employee/help')}>
      Back to list
    </button>
  );
}

function AppShell() {
  return (
    <>
      <PageToolbarProbe />
      <Routes>
        <Route
          path="/employee/help"
          element={
            <>
              <HelpListPage />
              <NavToDetail />
            </>
          }
        />
        <Route
          path="/employee/help/:id"
          element={
            <>
              <HelpDetailPage />
              <NavToList />
            </>
          }
        />
      </Routes>
    </>
  );
}

function renderHelpFlow() {
  return render(
    <MemoryRouter initialEntries={['/employee/help']}>
      <PageMetaProvider>
        <AppShell />
      </PageMetaProvider>
    </MemoryRouter>,
  );
}

describe('PageMetaProvider route overrides', () => {
  it('keeps a single toolbar action after navigating away and back', async () => {
    const user = userEvent.setup();
    renderHelpFlow();

    await waitFor(() => {
      expect(screen.getByTestId('toolbar-actions')).toHaveAttribute('data-count', '1');
      expect(screen.getByTestId('toolbar-actions')).toHaveAttribute('data-labels', 'New ticket');
    });

    await user.click(screen.getByRole('button', { name: 'Open ticket' }));

    await waitFor(() => {
      expect(screen.getByTestId('toolbar-actions')).toHaveAttribute('data-count', '1');
      expect(screen.getByTestId('toolbar-actions')).toHaveAttribute('data-labels', 'Back');
    });

    await user.click(screen.getByRole('button', { name: 'Back to list' }));

    await waitFor(() => {
      expect(screen.getByTestId('toolbar-actions')).toHaveAttribute('data-count', '1');
      expect(screen.getByTestId('toolbar-actions')).toHaveAttribute('data-labels', 'New ticket');
    });
  });
});
