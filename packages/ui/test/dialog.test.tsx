import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, Input } from '../src/index.js';

function Harness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Delivery address"
        description="Where should we send it?"
        dismissible={dismissible}
        footer={<Button onClick={() => setOpen(false)}>Save</Button>}
      >
        <Input aria-label="Street" />
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    render(<Dialog open={false} onOpenChange={vi.fn()} title="Hidden" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is labelled and described by its title and description', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Delivery address');
    expect(dialog).toHaveAccessibleDescription('Where should we send it?');
  });

  it('moves focus into the dialog and traps Tab inside it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const closeButton = screen.getByRole('button', { name: 'Close' });
    const street = screen.getByLabelText('Street');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(closeButton).toHaveFocus();

    await user.tab();
    expect(street).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();

    // Past the last element, focus wraps to the first one instead of escaping to the page.
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on overlay click, and does not when it is not dismissible', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByTestId('dialog-overlay'));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<Harness dismissible={false} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByTestId('dialog-overlay'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('locks and restores body scrolling', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
  });
});
