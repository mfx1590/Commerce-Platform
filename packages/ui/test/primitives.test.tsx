import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Skeleton,
  cn,
} from '../src/index.js';

describe('cn', () => {
  it('lets a caller override a base Tailwind utility', () => {
    expect(cn('rounded-md bg-primary', 'bg-destructive')).toBe('rounded-md bg-destructive');
  });
});

describe('Button', () => {
  it('defaults to type=button so it never submits a form by accident', () => {
    render(<Button>Add to cart</Button>);
    expect(screen.getByRole('button', { name: 'Add to cart' })).toHaveAttribute('type', 'button');
  });

  it('is operable with the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add to cart</Button>);

    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is disabled and marked busy while loading', () => {
    render(<Button loading>Placing order</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('applies variant and size classes', () => {
    render(
      <Button variant="outline" size="lg">
        Continue
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button.className).toContain('border-border');
    expect(button.className).toContain('h-12');
  });
});

describe('Input', () => {
  it('accepts typed text and reports invalid state', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Email" invalid />);
    const input = screen.getByLabelText('Email');

    await user.type(input, 'jane@example.com');
    expect(input).toHaveValue('jane@example.com');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Select', () => {
  it('is keyboard-selectable and reports the chosen value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select aria-label="Size" defaultValue="m" onChange={onChange}>
        <option value="s">Small</option>
        <option value="m">Medium</option>
        <option value="l">Large</option>
      </Select>,
    );
    const select = screen.getByLabelText('Size');

    await user.selectOptions(select, 'l');
    expect(select).toHaveValue('l');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Card', () => {
  it('renders its parts', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Order 1000</CardTitle>
          <CardDescription>Placed today</CardDescription>
        </CardHeader>
        <CardContent>2 items</CardContent>
        <CardFooter>Total</CardFooter>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Order 1000' })).toBeInTheDocument();
    expect(screen.getByText('Placed today')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('renders the chosen variant', () => {
    render(<Badge variant="success">In stock</Badge>);
    expect(screen.getByText('In stock').className).toContain('bg-success');
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive technology', () => {
    render(<Skeleton className="h-4 w-24" />);
    expect(screen.getByTestId('skeleton')).toHaveAttribute('aria-hidden', 'true');
  });
});
